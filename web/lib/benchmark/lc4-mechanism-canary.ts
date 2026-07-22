import { generateKeyPairSync } from "node:crypto";

import { AgentFlowSchema, type AgentFlow, type FlowBoundArgument } from "../flow";
import { canonicalJson, sha256Hex, verifyEventChain } from "./artifacts";
import {
  extractAudioBoundSlots,
  verifyAudioBoundSlotExtractionReceipt,
  type AudioBoundSlotAuthority,
  type AudioBoundSlotExtractionInput,
  type AudioBoundSlotExtractionReceipt,
  type AudioBoundSlotSpec,
} from "./audio-bound-slot-extraction";
import {
  compileConditionSuite,
  type CompiledBenchmarkCondition,
  type CompiledConditionSuite,
} from "./condition-compiler";
import {
  createConversationalRepairPlan,
  type ArmBlindRepairObservation,
  type ConversationalRepairPlan,
} from "./conversational-repair";
import {
  createInMemoryBenchmarkGatewayKernel,
  type InMemoryBenchmarkGatewayKernel,
} from "./gateway-kernel";
import {
  createBenchmarkKernelAttestationSigner,
  type BenchmarkKernelAttestationSigner,
  type BenchmarkKernelAttestationTrust,
  type BenchmarkKernelEvidenceBinding,
} from "./kernel-attestation";
import { verifyKernelTranscript } from "./kernel-transcript";
import {
  compileLc4DevelopmentAnalog,
  createLc4CallerAutomaton,
  type Lc4CallerAutomatonState,
  type Lc4CallerObservation,
  type Lc4DevelopmentAnalog,
  type Lc4Opportunity,
} from "./lc4-development-fixtures";
import {
  runLc4DevelopmentWorkerExperiment,
  type Lc4DevelopmentWorkerExperimentResult,
} from "./lc4-development-worker-runner";
import {
  runLc4RepairEpisode,
  type Lc4CallerPlayback,
  type Lc4CanonicalCallerTurn,
} from "./lc4-repair-runner";
import type { BenchmarkGatewayOutcome } from "./orchestrator";
import type { BenchmarkScenario } from "./scenario-schema";
import { createToolWorld, executeTool, type ToolWorldState } from "./tool-world";
import type { WhisperCppAsrNormalizedResult, WhisperCppAsrReceipt } from "./whisper-cpp-asr";

const ASR_RESULT_DOMAIN = "hacc/whisper-cpp-asr-result/v1\n";
const ASR_RECEIPT_DOMAIN = "hacc/whisper-cpp-asr-receipt/v1\n";
const CANARY_DOMAIN = "hacc/lc4/provider-free-mechanism-canary/v1\n";
const FIXED_ISO = "2026-07-21T22:00:00.000Z";
const CLOCK = Object.freeze({
  nowMs: () => Date.parse(FIXED_ISO),
  nowIso: () => FIXED_ISO,
});

export type Lc4CanaryArm = "native" | "hacc";

export type Lc4MechanismCanaryArmResult = Readonly<{
  arm: Lc4CanaryArm;
  provider_calls_made: 0;
  canonical_opportunities_planned: 60;
  canonical_opportunities_completed: 60;
  listener_evidence_callbacks: 60;
  caller_automaton_status: "completed";
  caller_disposition_head_sha256: string;
  audio_bound_slot: Readonly<{
    opportunity_id: string;
    receipt_sha256: string;
    status: "succeeded";
    canonical_value: string;
    replay_verified: true;
  }>;
  worker: Readonly<{
    evidence_verified: true;
    surface_sha256: string;
    world_sha256: string;
    worker_sha256: string;
    session_rotations: 2;
    committed_after_error_receipt_id: string;
    reconciliation_receipt_id: string;
    committed_effect_count: 1;
  }>;
  repair: Readonly<{
    terminal_class: "recovered";
    canonical_horizon_executed: 60;
    repair_turns_played: 1;
    repair_count: 1;
    trace_sha256: string;
    journal_head_sha256: string;
  }>;
  gateway: Readonly<{
    condition_hash: string;
    flow_hash: string;
    caller_turn_entries: 60;
    bound_source_receipt_id: string;
    bound_target_receipt_id: string;
    bound_argument_value: string;
    provider_schema_omits_bound_argument: true;
    argument_binding_sha256: string;
  }>;
  signed_replay: Readonly<{
    valid: true;
    authenticity: "signed_attestation_verified";
    transcript_entry_count: number;
    transcript_sha256: string;
    transcript_head_sha256: string;
    attestation_sha256: string;
    signing_public_key_sha256: string;
  }>;
  arm_common_projection_sha256: string;
}>;

export type Lc4MechanismCanaryResult = Readonly<{
  schema_version: 1;
  protocol_id: "HACC-LC4-MECHANISM-CANARY-v1";
  provider_free: true;
  provider_calls_authorized: false;
  provider_calls_made: 0;
  artifact_manifest_sha256: string;
  artifact_schedule_sha256: string;
  arm_common_evidence_binding_sha256: string;
  arms: Readonly<{
    native: Lc4MechanismCanaryArmResult;
    hacc: Lc4MechanismCanaryArmResult;
  }>;
  arm_common_infrastructure_parity: Readonly<{
    valid: true;
    native_projection_sha256: string;
    hacc_projection_sha256: string;
  }>;
  canary_sha256: string;
}>;

type BoundFlow = Readonly<{
  flow: AgentFlow;
  suite: CompiledConditionSuite;
  topic_id: string;
  source_action: string;
  target_action: string;
}>;

type AudioSlotFixture = Readonly<{
  input: AudioBoundSlotExtractionInput;
  receipt: AudioBoundSlotExtractionReceipt;
  opportunity: Lc4Opportunity;
}>;

function deterministicPcm(label: string): Uint8Array {
  const digest = Buffer.from(sha256Hex(label), "hex");
  const bytes = new Uint8Array(320);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = digest[index % digest.length]!;
  return bytes;
}

function attachBoundArgument(artifact: Lc4DevelopmentAnalog): BoundFlow {
  const flow = structuredClone(artifact.flow);
  const topic = flow.nodes.find((node) => node.kind === "topic");
  const step = topic?.steps?.find((candidate) => candidate.id === "checkpoint_02");
  const sourceAction = step?.tools?.find((tool) => tool.endsWith(".read_02"));
  const targetAction = step?.tools?.find((tool) => tool.endsWith(".apply_02"));
  const policy = step?.action_policies?.find((candidate) => candidate.tool === targetAction);
  if (!topic || !step || !sourceAction || !targetAction || !policy) {
    throw new Error("LC4 canary fixture is missing checkpoint-02 bound-argument surfaces");
  }
  const binding: FlowBoundArgument = {
    argument: "subject_id",
    source: { kind: "receipt_result", tool: sourceAction, result_path: "subject_id" },
  };
  policy.bound_arguments = [binding];
  const parsed = AgentFlowSchema.parse(flow);
  const suite = compileConditionSuite({ ...artifact.compilerInput, flow: parsed });
  return Object.freeze({
    flow: parsed,
    suite,
    topic_id: topic.id,
    source_action: sourceAction,
    target_action: targetAction,
  });
}

function canonicalTurns(artifact: Lc4DevelopmentAnalog): readonly Lc4CanonicalCallerTurn[] {
  return Object.freeze(artifact.schedule.opportunities.map((opportunity, index) => {
    const fixture = artifact.callerFixtures[index]!;
    const bytes = deterministicPcm(`caller-pcm\n${fixture.source_text_sha256}`);
    return Object.freeze({
      caller_turn_id: opportunity.id,
      canonical_opportunity_id: opportunity.id,
      stage_id: `stage.${opportunity.act}`,
      pcm: Object.freeze({
        caller_pcm_id: `caller.pcm.${String(opportunity.index).padStart(3, "0")}`,
        pcm_sha256: sha256Hex(bytes),
        byte_length: bytes.byteLength,
        sample_rate_hz: 24_000 as const,
        channels: 1 as const,
        encoding: "pcm16le" as const,
        bytes,
      }),
    });
  }));
}

function repairPlan(artifact: Lc4DevelopmentAnalog): Readonly<{
  plan: ConversationalRepairPlan;
  pcm_by_id: ReadonlyMap<string, Uint8Array>;
}> {
  const acts = ["establish", "interleave", "reconcile"] as const;
  const inventory = acts.map((act) => {
    const id = `repair.${act}.evidence`;
    const source = `Please use the authoritative receipt to reconcile the unresolved ${act} checkpoint.`;
    const bytes = deterministicPcm(`repair-pcm\n${source}`);
    return {
      fixture: {
        repair_pcm_id: id,
        stage_id: `stage.${act}`,
        blocker_code: "required_evidence_missing" as const,
        source_text_sha256: sha256Hex(source),
        pcm_sha256: sha256Hex(bytes),
        byte_length: bytes.byteLength,
        sample_rate_hz: 24_000 as const,
        channels: 1 as const,
        encoding: "pcm16le" as const,
        voice_id: "voice.provider-free-canary",
        repeats_spoken_fact_ids: [],
      },
      bytes,
    };
  });
  const plan = createConversationalRepairPlan({
    schema_version: 1,
    protocol_id: "HACC-LC4-v1",
    scenario_id: artifact.scenario.id,
    scenario_version: `version.${artifact.manifest.seed}`,
    stages: acts.map((act) => ({
      stage_id: `stage.${act}`,
      applicable_blockers: ["required_evidence_missing"] as const,
    })),
    pcm_inventory: inventory.map((item) => item.fixture),
  });
  return Object.freeze({
    plan,
    pcm_by_id: new Map(inventory.map((item) => [item.fixture.repair_pcm_id, item.bytes])),
  });
}

function audioSlotFixture(
  artifact: Lc4DevelopmentAnalog,
  turns: readonly Lc4CanonicalCallerTurn[],
): AudioSlotFixture {
  const opportunity = artifact.schedule.opportunities[13]!;
  const fixture = artifact.callerFixtures[13]!;
  const pcm = turns[13]!.pcm.bytes;
  const pcmSha256 = sha256Hex(pcm);
  const sourceRequestSha256 = sha256Hex(`lc4-canary-request\n${opportunity.id}`);
  const sourceChunkSequenceSha256 = sha256Hex(`lc4-canary-chunks\n${pcmSha256}`);
  const configSha256 = sha256Hex("lc4-canary-pinned-asr-config");
  const transcript = fixture.source_text;
  const normalizedResult: WhisperCppAsrNormalizedResult = {
    status: "completed",
    source_request_sha256: sourceRequestSha256,
    source_played_audio_sha256: pcmSha256,
    source_chunk_sequence_sha256: sourceChunkSequenceSha256,
    language: "en",
    transcript,
    processed_through_sample: pcm.byteLength / 2,
    no_speech_probability_ppm: null,
    spans: [{
      span_id: "span-000",
      text: transcript,
      utf8_start: 0,
      utf8_end: Buffer.byteLength(transcript, "utf8"),
      audio_start_sample: 0,
      audio_end_sample: pcm.byteLength / 2,
      confidence_ppm: null,
    }],
  };
  const normalizedResultSha256 = sha256Hex(`${ASR_RESULT_DOMAIN}${canonicalJson(normalizedResult)}`);
  const receiptBody = {
    schema_version: 1 as const,
    receipt_type: "hacc_whisper_cpp_asr" as const,
    invocation_id: "asr.lc4.canary.014",
    run_id: "lc4.canary.audio",
    unit_id: "caller.opportunity.014",
    source_request_sha256: sourceRequestSha256,
    source_played_audio_sha256: pcmSha256,
    source_chunk_sequence_sha256: sourceChunkSequenceSha256,
    config_sha256: configSha256,
    toolchain_verification: { mode: "per_invocation_full_hash" as const, batch_id: null },
    input: {
      encoding: "pcm16" as const,
      endianness: "little" as const,
      sample_rate_hz: 24_000 as const,
      channels: 1 as const,
      byte_length: pcm.byteLength,
      sample_count: pcm.byteLength / 2,
      pcm_sha256: pcmSha256,
    },
    toolchain: {
      whisper_cpp_source_revision: "a".repeat(40),
      whisper_cpp_version: "1.9.1",
      whisper_cli_path_sha256: sha256Hex("lc4-canary-whisper-path"),
      whisper_cli_sha256: sha256Hex("lc4-canary-whisper-bin"),
      model_id: "ggml-small.en",
      model_revision: "b".repeat(40),
      model_path_sha256: sha256Hex("lc4-canary-model-path"),
      model_sha256: sha256Hex("lc4-canary-model"),
      ffmpeg_path_sha256: sha256Hex("lc4-canary-ffmpeg-path"),
      ffmpeg_sha256: sha256Hex("lc4-canary-ffmpeg"),
    },
    conversion: {
      profile: "ffmpeg-pcm16le-24khz-mono-to-wav-pcm16le-16khz-mono-bitexact-v1" as const,
      argv_sha256: sha256Hex("lc4-canary-ffmpeg-argv"),
      wav_sha256: sha256Hex("lc4-canary-wav"),
      wav_byte_length: 1_024,
      runtime_ms: 1,
    },
    inference: {
      argv_sha256: sha256Hex("lc4-canary-whisper-argv"),
      runtime_ms: 1,
      stdout_sha256: sha256Hex("lc4-canary-stdout"),
      stderr_sha256: sha256Hex("lc4-canary-stderr"),
      exit_code: 0 as const,
    },
    transcript_file_sha256: sha256Hex(`${transcript}\n`),
    normalized_result_sha256: normalizedResultSha256,
    result: normalizedResult,
  };
  const asrReceipt: WhisperCppAsrReceipt = {
    ...receiptBody,
    receipt_sha256: sha256Hex(`${ASR_RECEIPT_DOMAIN}${canonicalJson(receiptBody)}`),
  };
  const authority: AudioBoundSlotAuthority = {
    schema_version: 1,
    run_id: asrReceipt.run_id,
    unit_id: asrReceipt.unit_id,
    invocation_id: asrReceipt.invocation_id,
    opportunity_id: opportunity.id,
    authority_artifact_sha256: artifact.manifest.fixture_manifest_sha256,
    caller_pcm_sha256: pcmSha256,
    source_request_sha256: sourceRequestSha256,
    source_chunk_sequence_sha256: sourceChunkSequenceSha256,
    asr_config_sha256: configSha256,
    asr_receipt_sha256: asrReceipt.receipt_sha256,
  };
  const spec: AudioBoundSlotSpec = {
    schema_version: 1,
    extraction_id: "extract.lc4.goal.014",
    slots: [{
      slot_id: "active_goal",
      candidates: [{
        candidate_id: "goal.active",
        canonical_value: opportunity.goal_id,
        spoken_forms: [fixture.source_text],
      }],
    }],
  };
  const input = Object.freeze({ authority, callerPcm: pcm, asrReceipt, spec });
  const receipt = extractAudioBoundSlots(input);
  const verification = verifyAudioBoundSlotExtractionReceipt(input, receipt);
  if (!verification.valid || receipt.status !== "succeeded" || receipt.slots[0]?.status !== "resolved") {
    throw new Error(`LC4 canary audio-bound slot receipt failed replay: ${verification.errors.join(", ")}`);
  }
  return Object.freeze({ input, receipt, opportunity });
}

function createSigner(): Readonly<{
  signer: BenchmarkKernelAttestationSigner;
  trust: BenchmarkKernelAttestationTrust;
}> {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const signer = createBenchmarkKernelAttestationSigner({
    keyId: "lc4-canary-ed25519-v1",
    privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem,
  });
  return Object.freeze({
    signer,
    trust: Object.freeze({
      keyId: signer.keyId,
      publicKeySha256: signer.publicKeySha256,
      publicKeyPem,
    }),
  });
}

function workerEvidence(worker: Lc4DevelopmentWorkerExperimentResult) {
  if (!worker.verification.valid || !worker.world_success) {
    throw new Error(`LC4 ${worker.arm} worker evidence did not verify`);
  }
  const rotations = worker.snapshot.evidence.filter((receipt) => receipt.kind === "session.rehydrated");
  const committed = worker.snapshot.world.receipts.find((receipt) => receipt.status === "committed_after_error");
  const reconciliation = worker.snapshot.world.receipts.find((receipt) =>
    receipt.tool.endsWith(".read_07") && committed !== undefined && receipt.turn > committed.turn
  );
  if (rotations.length !== 2 || !committed || !reconciliation) {
    throw new Error(`LC4 ${worker.arm} worker run missed rotation or reconciliation evidence`);
  }
  const effectCount = worker.snapshot.world.facts.checkpoint_07_count;
  if (effectCount !== 1) throw new Error("LC4 committed-after-error effect was not exactly once");
  return Object.freeze({
    evidence_verified: true as const,
    surface_sha256: sha256Hex(canonicalJson(worker.surface)),
    world_sha256: sha256Hex(canonicalJson(worker.snapshot.world)),
    worker_sha256: sha256Hex(canonicalJson(worker.snapshot.worker)),
    session_rotations: 2 as const,
    committed_after_error_receipt_id: committed.receipt_id,
    reconciliation_receipt_id: reconciliation.receipt_id,
    committed_effect_count: 1 as const,
  });
}

type GatewayHarness = {
  kernel: InMemoryBenchmarkGatewayKernel;
  condition: CompiledBenchmarkCondition;
  scenario: BenchmarkScenario;
  snapshot: ReturnType<InMemoryBenchmarkGatewayKernel["initialize"]>;
  world: ToolWorldState;
  callSequence: number;
  activeOpportunity: Lc4Opportunity | null;
};

function grant(harness: GatewayHarness, action: string): string {
  const capability = harness.snapshot.actions.find((candidate) => candidate.name === action);
  if (!capability) throw new Error(`LC4 canary gateway does not expose ${action}`);
  return capability.capability_grant;
}

function invokeGateway(
  harness: GatewayHarness,
  action: string,
  args: Readonly<Record<string, string>>,
  turn: number,
): BenchmarkGatewayOutcome {
  harness.callSequence += 1;
  let acceptedWorld: ToolWorldState | null = null;
  const outcome = harness.kernel.invoke({
    providerCallId: `canary-call-${String(harness.callSequence).padStart(3, "0")}`,
    call: { action, arguments: args, capability_grant: grant(harness, action) },
    capabilityEpoch: harness.snapshot.capability_epoch,
    condition: harness.condition,
    turn,
    world: structuredClone(harness.world),
    executeLeaf: (request) => {
      const execution = executeTool(harness.scenario, harness.world, {
        invocation_id: `canary-world-${String(harness.callSequence).padStart(3, "0")}`,
        tool: request.action,
        arguments: structuredClone(request.arguments),
        turn,
        ...(harness.activeOpportunity
          ? { semantic_opportunity_id: harness.activeOpportunity.id }
          : {}),
        ...(request.idempotencyKey ? { idempotency_key: request.idempotencyKey } : {}),
      });
      acceptedWorld = execution.state;
      return execution;
    },
  });
  if (acceptedWorld) harness.world = acceptedWorld;
  if (outcome.capabilitySnapshot) harness.snapshot = outcome.capabilitySnapshot;
  if (!outcome.result.ok) throw new Error(`LC4 canary gateway ${action} failed: ${outcome.result.code}`);
  return outcome;
}

function publicArgumentBindingSha256(
  kernel: InMemoryBenchmarkGatewayKernel,
  targetAction: string,
): string {
  for (const entry of [...kernel.transcript().entries].reverse()) {
    if (entry.operation !== "invoke" || !entry.payload || typeof entry.payload !== "object"
      || Array.isArray(entry.payload)) continue;
    const input = entry.payload.input;
    if (!input || typeof input !== "object" || Array.isArray(input)) continue;
    if (input.action === targetAction && typeof input.argument_binding_sha256 === "string") {
      return input.argument_binding_sha256;
    }
  }
  throw new Error("LC4 canary public transcript omitted bound-argument evidence");
}

function providerSchemaOmitsSubject(
  condition: CompiledBenchmarkCondition,
  topicId: string,
  targetAction: string,
): boolean {
  const disclosure = condition.disclosures.find((candidate) =>
    candidate.target === `step:${topicId}.checkpoint_02`
  );
  const capability = disclosure?.visibleCapabilities.find((candidate) => candidate.name === targetAction);
  if (!capability) throw new Error("LC4 canary compiled disclosure omitted the target action");
  const schema = capability.inputSchema as Readonly<{ properties?: Readonly<Record<string, unknown>> }>;
  return !schema.properties || !("subject_id" in schema.properties);
}

function listenerEvidenceStub(input: Readonly<{
  artifact: Lc4DevelopmentAnalog;
  opportunity: Lc4Opportunity;
  playback: Extract<Lc4CallerPlayback, { kind: "canonical" }>;
  audio_slot_opportunity_index: number;
}>): Lc4CallerObservation {
  const audioVisible = input.opportunity.index >= input.audio_slot_opportunity_index;
  return Object.freeze({
    schema_version: 1 as const,
    schedule_sha256: input.artifact.schedule.schedule_sha256,
    opportunity_id: input.opportunity.id,
    observed_world_revision: input.opportunity.index,
    outcome: "heard" as const,
    listener_heard_audio_sha256: sha256Hex(canonicalJson({
      listener_stub: "provider-free-v1",
      opportunity_id: input.opportunity.id,
      caller_pcm_sha256: input.playback.pcm.pcm_sha256,
    })),
    visible_receipt_ids: audioVisible ? ["audio.slot.receipt.014"] : [],
    visible_worker_result_ids: [],
  });
}

async function runArm(input: Readonly<{
  arm: Lc4CanaryArm;
  artifact: Lc4DevelopmentAnalog;
  bound: BoundFlow;
  turns: readonly Lc4CanonicalCallerTurn[];
  repair: ReturnType<typeof repairPlan>;
  audio: AudioSlotFixture;
  worker: ReturnType<typeof workerEvidence>;
  evidence_binding: BenchmarkKernelEvidenceBinding;
  signer: BenchmarkKernelAttestationSigner;
  trust: BenchmarkKernelAttestationTrust;
}>): Promise<Lc4MechanismCanaryArmResult> {
  const condition = input.bound.suite.conditions["host-managed-harness"];
  const runId = `lc4-canary-${input.arm}`;
  const kernel = createInMemoryBenchmarkGatewayKernel({
    flow: input.bound.flow,
    expectedFlowHash: input.bound.suite.flowHash,
    expectedScenarioHash: input.bound.suite.scenarioHash,
    expectedConditionHash: condition.conditionHash,
    grantBindingHash: input.bound.suite.sourceHash,
    leaseSubjectId: input.evidence_binding.leaseSubjectId,
    evidenceBinding: input.evidence_binding,
    signer: input.signer,
    capabilitySecret: "lc4-provider-free-canary-shared-capability-secret-v1",
    clock: CLOCK,
  });
  const world = createToolWorld(input.artifact.scenario);
  const harness: GatewayHarness = {
    kernel,
    condition,
    scenario: input.artifact.scenario,
    snapshot: kernel.initialize({
      runId,
      condition,
      scenario: input.artifact.scenario,
      world,
    }),
    world,
    callSequence: 0,
    activeOpportunity: null,
  };
  const caller = createLc4CallerAutomaton(input.artifact);
  let callerState: Lc4CallerAutomatonState = caller.initialState;
  let listenerCallbacks = 0;
  const subjectId = input.artifact.scenario.initial_facts.subject_id;
  if (typeof subjectId !== "string") throw new Error("LC4 canary subject ID is missing");
  const committedOpportunity = input.artifact.schedule.opportunities.find((opportunity) =>
    opportunity.stressors.some((stressor) => stressor.kind === "committed_after_error")
  );
  if (!committedOpportunity) throw new Error("LC4 canary schedule has no committed-after-error opportunity");

  const repairResult = await runLc4RepairEpisode({
    run_id: `lc4.repair.${input.arm}`,
    episode_id: `episode.${input.arm}`,
    plan: input.repair.plan,
    canonical_turns: input.turns,
    load_repair_pcm: (fixture) => {
      const bytes = input.repair.pcm_by_id.get(fixture.repair_pcm_id);
      if (!bytes) throw new Error(`missing canary repair PCM ${fixture.repair_pcm_id}`);
      return bytes.slice();
    },
    play_caller_pcm: (playback) => {
      if (playback.kind === "repair") return { repair_observation: null };
      const opportunity = input.artifact.schedule.opportunities[playback.canonical_ordinal - 1];
      if (!opportunity) throw new Error("LC4 canary playback points outside the frozen schedule");
      harness.activeOpportunity = opportunity;
      const turn = kernel.advanceCallerTurn({
        runId,
        condition,
        scenario: input.artifact.scenario,
        turn: playback.canonical_ordinal,
        turnId: opportunity.id,
        world: harness.world,
      });
      harness.snapshot = turn.capabilitySnapshot;

      if (playback.canonical_ordinal === 1) {
        invokeGateway(harness, "flow.select_topic", { topic_id: input.bound.topic_id }, 1);
        const firstApply = input.artifact.scenario.tools.find((tool) => tool.name.endsWith(".apply_01"));
        if (!firstApply) throw new Error("LC4 canary fixture is missing checkpoint-01 mutation");
        invokeGateway(harness, firstApply.name, { subject_id: subjectId }, 1);
        invokeGateway(harness, input.bound.source_action, { subject_id: subjectId }, 1);
        invokeGateway(harness, input.bound.target_action, {}, 1);
      }

      listenerCallbacks += 1;
      const heard = listenerEvidenceStub({
        artifact: input.artifact,
        opportunity,
        playback,
        audio_slot_opportunity_index: input.audio.opportunity.index,
      });
      callerState = caller.commit(callerState, heard);
      const observation: ArmBlindRepairObservation = {
        schema_version: 1,
        episode_id: `episode.${input.arm}`,
        caller_turn_id: opportunity.id,
        canonical_opportunity_id: opportunity.id,
        stage_id: `stage.${opportunity.act}`,
        deadline_reached: true,
        common_state_sha256: sha256Hex(canonicalJson({
          caller_state_sha256: callerState.state_sha256,
          gateway_world_sha256: sha256Hex(canonicalJson(harness.world)),
          worker_world_sha256: input.worker.world_sha256,
          worker_state_sha256: input.worker.worker_sha256,
        })),
        listener_heard_semantics_sha256: heard.listener_heard_audio_sha256!,
        spoken_caller_fact_ids: [],
        visible_receipt_ids: heard.visible_receipt_ids,
        visible_worker_result_ids: heard.visible_worker_result_ids,
        unmet_blocker_codes: opportunity.id === committedOpportunity.id
          ? ["required_evidence_missing"]
          : [],
      };
      return { repair_observation: observation };
    },
    terminal_evidence: () => ({
      scenario_invalid: false,
      system_failure: false,
      harness_deadlock: false,
      transport_failure: false,
      mission_complete: callerState.status === "completed" && input.worker.evidence_verified,
      absorbing_model_policy_attempt: false,
    }),
    now: () => FIXED_ISO,
  });

  if (callerState.status !== "completed" || callerState.dispositions.length !== 60
    || listenerCallbacks !== 60 || repairResult.canonical_horizon_executed !== 60
    || repairResult.repair_turns_played !== 1 || repairResult.terminal.terminal_class !== "recovered"
    || !verifyEventChain(repairResult.journal).valid) {
    throw new Error(`LC4 ${input.arm} canary did not complete the exact 60-opportunity horizon`);
  }

  const sourceReceipt = harness.world.receipts.find((receipt) => receipt.tool === input.bound.source_action);
  const targetReceipt = harness.world.receipts.find((receipt) => receipt.tool === input.bound.target_action);
  if (!sourceReceipt || !targetReceipt || targetReceipt.arguments.subject_id !== subjectId) {
    throw new Error(`LC4 ${input.arm} bound argument was not injected from authoritative receipt evidence`);
  }
  const schemaOmitsSubject = providerSchemaOmitsSubject(condition, input.bound.topic_id, input.bound.target_action);
  if (!schemaOmitsSubject) throw new Error("LC4 canary exposed a host-bound argument to the model schema");
  const argumentBindingSha256 = publicArgumentBindingSha256(kernel, input.bound.target_action);
  if (!/^[a-f0-9]{64}$/.test(argumentBindingSha256)) {
    throw new Error("LC4 canary bound-argument evidence hash is malformed");
  }

  const transcript = kernel.transcript();
  const callerTurnEntries = transcript.entries.filter((entry) => entry.operation === "caller_turn").length;
  if (callerTurnEntries !== 60) throw new Error(`LC4 ${input.arm} signed transcript has ${callerTurnEntries} caller turns`);
  const transcriptReference = kernel.transcriptReference();
  const attestation = kernel.attestFinal({
    runId,
    condition,
    scenario: input.artifact.scenario,
    world: harness.world,
  });
  const replay = verifyKernelTranscript({
    transcript: kernel.encodedTranscript(),
    finalAttestation: attestation,
    attestationExpectation: {
      runId,
      condition,
      scenario: input.artifact.scenario,
      world: harness.world,
      transcriptReference,
      evidenceBinding: input.evidence_binding,
      trust: input.trust,
    },
  });
  if (!replay.valid || replay.authenticity !== "signed_attestation_verified") {
    throw new Error(`LC4 ${input.arm} signed replay failed: ${replay.errors.join(", ")}`);
  }

  const slot = input.audio.receipt.slots[0];
  if (!slot || slot.status !== "resolved" || typeof slot.canonical_value !== "string") {
    throw new Error("LC4 canary audio slot is not resolved to a string");
  }
  const journalHead = repairResult.journal.at(-1)?.event_hash;
  const dispositionHead = callerState.dispositions.at(-1)?.disposition_sha256;
  if (!journalHead || !dispositionHead) throw new Error("LC4 canary evidence chain has no terminal head");

  const commonProjection = Object.freeze({
    artifact_manifest_sha256: input.artifact.manifest.manifest_sha256,
    artifact_schedule_sha256: input.artifact.schedule.schedule_sha256,
    canonical_opportunities: repairResult.canonical_horizon_executed,
    listener_callbacks: listenerCallbacks,
    caller_disposition_head_sha256: dispositionHead,
    audio_receipt_sha256: input.audio.receipt.receipt_sha256,
    audio_canonical_value: slot.canonical_value,
    worker: input.worker,
    repair_trace_sha256: repairResult.arm_blind_repair_trace_sha256,
    repair_count: repairResult.repair_state.repair_count,
    gateway_condition_hash: condition.conditionHash,
    gateway_flow_hash: input.bound.suite.flowHash,
    gateway_caller_turn_entries: callerTurnEntries,
    bound_argument_value: subjectId,
    provider_schema_omits_bound_argument: schemaOmitsSubject,
    signed_replay_valid: replay.valid,
    signed_replay_authenticity: replay.authenticity,
    transcript_entry_count: transcriptReference.transcript_entry_count,
    signing_public_key_sha256: input.signer.publicKeySha256,
  });
  const armCommonProjectionSha256 = sha256Hex(`${CANARY_DOMAIN}${canonicalJson(commonProjection)}`);

  return Object.freeze({
    arm: input.arm,
    provider_calls_made: 0 as const,
    canonical_opportunities_planned: 60 as const,
    canonical_opportunities_completed: 60 as const,
    listener_evidence_callbacks: 60 as const,
    caller_automaton_status: "completed" as const,
    caller_disposition_head_sha256: dispositionHead,
    audio_bound_slot: Object.freeze({
      opportunity_id: input.audio.opportunity.id,
      receipt_sha256: input.audio.receipt.receipt_sha256,
      status: "succeeded" as const,
      canonical_value: slot.canonical_value,
      replay_verified: true as const,
    }),
    worker: input.worker,
    repair: Object.freeze({
      terminal_class: "recovered" as const,
      canonical_horizon_executed: 60 as const,
      repair_turns_played: 1 as const,
      repair_count: 1 as const,
      trace_sha256: repairResult.arm_blind_repair_trace_sha256,
      journal_head_sha256: journalHead,
    }),
    gateway: Object.freeze({
      condition_hash: condition.conditionHash,
      flow_hash: input.bound.suite.flowHash,
      caller_turn_entries: 60 as const,
      bound_source_receipt_id: sourceReceipt.receipt_id,
      bound_target_receipt_id: targetReceipt.receipt_id,
      bound_argument_value: subjectId,
      provider_schema_omits_bound_argument: true as const,
      argument_binding_sha256: argumentBindingSha256,
    }),
    signed_replay: Object.freeze({
      valid: true as const,
      authenticity: "signed_attestation_verified" as const,
      transcript_entry_count: transcriptReference.transcript_entry_count,
      transcript_sha256: transcriptReference.transcript_sha256,
      transcript_head_sha256: transcriptReference.transcript_head_sha256,
      attestation_sha256: attestation.attestation_hash,
      signing_public_key_sha256: input.signer.publicKeySha256,
    }),
    arm_common_projection_sha256: armCommonProjectionSha256,
  });
}

/**
 * One provider-free, executable composition proof for the LC4 mechanism stack.
 * It is explicitly a release canary, not efficacy evidence and not a provider
 * benchmark result.
 */
export async function runLc4MechanismCanary(): Promise<Lc4MechanismCanaryResult> {
  const artifact = compileLc4DevelopmentAnalog({
    family: "freight-customs",
    variant: "committed-reconciliation",
    seed: 4_242,
  });
  if (artifact.schedule.opportunities.length !== 60 || artifact.manifest.provider_calls_authorized) {
    throw new Error("LC4 mechanism canary requires the provider-blocked 60-opportunity development artifact");
  }
  const bound = attachBoundArgument(artifact);
  const turns = canonicalTurns(artifact);
  const repair = repairPlan(artifact);
  const audio = audioSlotFixture(artifact, turns);
  const nativeWorker = workerEvidence(runLc4DevelopmentWorkerExperiment({
    artifact,
    arm: "native",
    clock: CLOCK,
  }));
  const haccWorker = workerEvidence(runLc4DevelopmentWorkerExperiment({
    artifact,
    arm: "hacc",
    clock: CLOCK,
  }));
  const commonWorkerProjection = (worker: ReturnType<typeof workerEvidence>) => Object.freeze({
    surface_sha256: worker.surface_sha256,
    world_sha256: worker.world_sha256,
    worker_sha256: worker.worker_sha256,
    session_rotations: worker.session_rotations,
    committed_after_error_receipt_id: worker.committed_after_error_receipt_id,
    reconciliation_receipt_id: worker.reconciliation_receipt_id,
    committed_effect_count: worker.committed_effect_count,
  });
  const workerCommon = commonWorkerProjection(nativeWorker);
  const haccWorkerCommon = commonWorkerProjection(haccWorker);
  if (canonicalJson(workerCommon) !== canonicalJson(haccWorkerCommon)) {
    throw new Error("LC4 Native/HACC worker infrastructure diverged before the paired canary");
  }
  const freezeLockSha256 = sha256Hex(`${CANARY_DOMAIN}${canonicalJson({
    schedule_sha256: artifact.schedule.schedule_sha256,
    caller_fixture_manifest_sha256: artifact.manifest.fixture_manifest_sha256,
    audio_slot_receipt_sha256: audio.receipt.receipt_sha256,
    repair_plan_sha256: repair.plan.plan_sha256,
    worker_common: workerCommon,
  })}`);
  const evidenceBinding: BenchmarkKernelEvidenceBinding = Object.freeze({
    pairId: "lc4-canary-pair",
    leaseSubjectId: "lc4-canary-pair",
    provider: "offline",
    model: "provider-free-lc4-mechanism-canary-v1",
    planSha256: artifact.manifest.manifest_sha256,
    freezeLockSha256,
    kernelBuildSha256: bound.suite.suiteHash,
  });
  const signing = createSigner();
  const [native, hacc] = await Promise.all([
    runArm({
      arm: "native", artifact, bound, turns, repair, audio, worker: nativeWorker,
      evidence_binding: evidenceBinding, signer: signing.signer, trust: signing.trust,
    }),
    runArm({
      arm: "hacc", artifact, bound, turns, repair, audio, worker: haccWorker,
      evidence_binding: evidenceBinding, signer: signing.signer, trust: signing.trust,
    }),
  ]);
  if (native.arm_common_projection_sha256 !== hacc.arm_common_projection_sha256) {
    throw new Error("LC4 Native/HACC arm-common infrastructure parity failed");
  }
  const body = Object.freeze({
    schema_version: 1 as const,
    protocol_id: "HACC-LC4-MECHANISM-CANARY-v1" as const,
    provider_free: true as const,
    provider_calls_authorized: false as const,
    provider_calls_made: 0 as const,
    artifact_manifest_sha256: artifact.manifest.manifest_sha256,
    artifact_schedule_sha256: artifact.schedule.schedule_sha256,
    arm_common_evidence_binding_sha256: sha256Hex(canonicalJson(evidenceBinding)),
    arms: Object.freeze({ native, hacc }),
    arm_common_infrastructure_parity: Object.freeze({
      valid: true as const,
      native_projection_sha256: native.arm_common_projection_sha256,
      hacc_projection_sha256: hacc.arm_common_projection_sha256,
    }),
  });
  return Object.freeze({
    ...body,
    canary_sha256: sha256Hex(`${CANARY_DOMAIN}${canonicalJson(body)}`),
  });
}
