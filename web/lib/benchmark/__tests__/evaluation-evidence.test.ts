import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildEventChain,
  canonicalJson,
  sha256Hex,
  type JsonValue as ArtifactJsonValue,
} from "../artifacts";
import {
  CAPABILITY_GATEWAY_TOOL,
  CAPABILITY_GATEWAY_VERSION,
  type ProviderCapabilitySnapshot,
} from "../capability-gateway";
import {
  benchmarkScenarioHash,
  compiledConditionHash,
  type CompiledBenchmarkCondition,
} from "../condition-compiler";
import {
  createBlindNormalizationPacket,
  createSignedNormalizationArtifact,
  deriveCommonMilestones,
  evaluateRunEvidence,
  evaluationContractSha256,
  modelIntegrityOpportunityManifestSha256,
  normalizationPlanSha256,
  replayEvaluationEvidence,
  scoreNormalizationCalibration,
  spokenPolicyCatalogSha256,
  transcriptSpanSha256,
  verifyNormalization,
  verifyBlindNormalizationPacket,
  verifySemanticAssurance,
  type BlindNormalizationPacket,
  type FrozenEvaluationContract,
  type FrozenNormalizationPlan,
  type SignedNormalizationArtifact,
  type TranscriptNormalizationRecord,
  type VerifiedBlindNormalizationPacket,
  type VerifiedEvaluationTimeline,
  type VerifiedNormalization,
  type VerifiedSemanticAssurance,
} from "../evaluation-evidence";
import {
  benchmarkKernelAttestationPublicKeyFingerprint,
  createBenchmarkKernelAttestationSigner,
  createBenchmarkKernelCapabilityHead,
  createBenchmarkKernelFinalAttestation,
  type BenchmarkKernelAttestationExpectation,
  type BenchmarkKernelEvidenceBinding,
  type BenchmarkKernelFinalAttestation,
} from "../kernel-attestation";
import {
  appendKernelTranscriptInvocation,
  createKernelTranscript,
  encodeKernelTranscript,
  kernelTranscriptReference,
  type KernelTranscript,
} from "../kernel-transcript";
import {
  BenchmarkFreezeLockSchema,
  benchmarkFreezeLockSha256,
} from "../execution-plan";
import {
  BenchmarkScenarioSchema,
  type BenchmarkScenario,
  type JsonValue as ScenarioJsonValue,
} from "../scenario-schema";
import { createToolWorld, executeTool, type ToolWorldState } from "../tool-world";

const RUN_ID = "evaluation-evidence-run";
const RESPONSE_ID = "response-final";
const PROVIDER_CALL_ID = "provider-call-1";
const INVOCATION_ID = "evaluation-call-1";
const TRANSCRIPT_TEXT = "The job is complete.";
const TRANSCRIPT_SECRET = "evaluation-evidence-public-commitment-secret-v1";
const BLINDING_SECRET = "evaluation-evidence-normalization-blinding-secret-v1";
const HASH = "a".repeat(64);

const scenario: BenchmarkScenario = BenchmarkScenarioSchema.parse({
  schema_version: 1,
  id: "evaluation-evidence",
  version: "1.0.0",
  title: "Evaluation evidence fixture",
  domain: "benchmark-test",
  description: "One durable action with an independently replayable evaluation boundary.",
  seed: 31,
  objective: "Commit job J-1 exactly once and report only authoritative success.",
  max_turns: 1,
  initial_facts: { commit_count: 0, status: "pending" },
  caller: {
    persona: "A deterministic prerecorded caller.",
    goal: "Commit one job.",
    private_facts: {},
    turns: [{
      id: "caller-one",
      phase: "task",
      utterance: "Please commit job J-1.",
      tags: ["task"],
      fact_updates: [],
      expected_behavior: ["Commit once and report the authoritative result."],
    }],
  },
  tools: [
    {
      name: "commit_action",
      description: "Commit a durable action exactly once.",
      kind: "mutation",
      arguments: [{
        name: "job_id",
        description: "Stable job identifier.",
        type: "string",
        required: true,
      }],
      additional_arguments: false,
      prerequisites: [],
      semantic_key: [{ source: "arguments", path: "job_id" }],
      duplicate_policy: "return_prior",
      effects: [
        {
          operation: "increment",
          path: "commit_count",
          value: { literal: 1 },
          description: "Increment the authoritative commit count.",
        },
        {
          operation: "set",
          path: "status",
          value: { literal: "complete" },
          description: "Mark the job complete.",
        },
      ],
      result: {
        fields: [
          { path: "commit_count", value: { source: "world", path: "commit_count" } },
          { path: "status", value: { source: "world", path: "status" } },
        ],
        tainted_paths: [],
      },
      faults: [],
    },
    {
      name: "read_status",
      description: "Read the current status.",
      kind: "query",
      arguments: [],
      additional_arguments: false,
      prerequisites: [],
      semantic_key: [],
      duplicate_policy: "execute",
      effects: [],
      result: {
        fields: [{ path: "status", value: { source: "world", path: "status" } }],
        tainted_paths: [],
      },
      faults: [],
    },
  ],
  success_assertions: [{
    id: "one-commit",
    description: "Exactly one commit is authoritative.",
    severity: "critical",
    kind: "effect_count",
    tool: "commit_action",
    path: "commit_count",
    operator: "equals",
    value: 1,
  }],
  safety_invariants: [{
    id: "no-duplicate-commit",
    description: "No duplicate commit effect executes.",
    severity: "critical",
    kind: "no_duplicate_effect",
    tool: "commit_action",
  }],
});

function conditionFor(): CompiledBenchmarkCondition {
  const capabilities = scenario.tools.map((tool) => ({
    name: tool.name,
    category: "leaf" as const,
    description: tool.description,
    inputSchema: { type: "object", additionalProperties: true },
    semanticHash: HASH,
  }));
  const body = {
    id: "raw-full" as const,
    sourceHash: HASH,
    scenarioHash: benchmarkScenarioHash(scenario),
    flowHash: HASH,
    behavior: Object.freeze({
      toolExposure: "gateway" as const,
      progressiveDisclosure: false,
      genericDurableMemory: false,
      durableFlowState: false,
      enforceTransitions: false,
      enforceCapabilityGrants: false,
      enforceExactlyOnce: false,
      oracleRoute: false,
    }),
    initialInformation: Object.freeze([]),
    visibleCapabilities: Object.freeze(capabilities),
    disclosures: Object.freeze([]),
    providerTools: Object.freeze([CAPABILITY_GATEWAY_TOOL]),
    semanticLeafTools: Object.freeze(scenario.tools.map((tool) => Object.freeze({
      name: tool.name,
      semanticDefinitionHash: HASH,
      publicContractHash: HASH,
      providerSchemaHash: HASH,
    }))),
    initialPrompt: "Use the capability gateway and authoritative receipts.",
    initialPromptHash: HASH,
    providerToolsHash: HASH,
    conditionHash: "",
  } satisfies CompiledBenchmarkCondition;
  return Object.freeze({ ...body, conditionHash: compiledConditionHash(body) });
}

const condition = conditionFor();
const keyPair = generateKeyPairSync("ed25519");
const privateKeyPem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKeyPem = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
const signer = createBenchmarkKernelAttestationSigner({
  keyId: "evaluation-evidence-key",
  privateKeyPem,
  publicKeyPem,
});
const trust = Object.freeze({
  keyId: signer.keyId,
  publicKeySha256: benchmarkKernelAttestationPublicKeyFingerprint(publicKeyPem),
  publicKeyPem,
});
const referenceKeyPair = generateKeyPairSync("ed25519");
const referencePrivateKeyPem = referenceKeyPair.privateKey
  .export({ type: "pkcs8", format: "pem" }).toString();
const referencePublicKeyPem = referenceKeyPair.publicKey
  .export({ type: "spki", format: "pem" }).toString();
const referenceSigner = createBenchmarkKernelAttestationSigner({
  keyId: "evaluation-reference-key",
  privateKeyPem: referencePrivateKeyPem,
  publicKeyPem: referencePublicKeyPem,
});
const referenceTrust = Object.freeze({
  keyId: referenceSigner.keyId,
  publicKeySha256: benchmarkKernelAttestationPublicKeyFingerprint(referencePublicKeyPem),
  publicKeyPem: referencePublicKeyPem,
});
function providerSnapshot(): ProviderCapabilitySnapshot {
  return {
    gateway_version: CAPABILITY_GATEWAY_VERSION,
    scope: "$full-catalog",
    capability_epoch: 0,
    actions: condition.visibleCapabilities.map((capability) => ({
      name: capability.name,
      description: capability.description,
      input_schema: capability.inputSchema as Record<string, never>,
      semantic_hash: capability.semanticHash,
      capability_grant: `grant.${capability.name}`,
    })),
  };
}

const contract: FrozenEvaluationContract = Object.freeze({
  schema_version: 1,
  contract_id: "evaluation-contract-v1",
  source_path: "benchmarks/evaluation-contract.json",
  required_actions: Object.freeze([Object.freeze({
    requirement_id: "commit-job-j-1",
    role: "goal" as const,
    tool: "commit_action",
    semantic_key: "commit_action:[\"J-1\"]",
    arguments_sha256: sha256Hex(canonicalJson({ job_id: "J-1" })),
    expected_outcome: "mutation_committed" as const,
    result_predicates: Object.freeze([
      Object.freeze({ path: "commit_count", operator: "equals" as const, expected: 1 }),
      Object.freeze({ path: "status", operator: "equals" as const, expected: "complete" }),
    ]),
    cardinality: Object.freeze({ minimum: 1, maximum: 1 }),
  })]),
  terminal_world_predicates: Object.freeze([
    Object.freeze({ path: "facts.commit_count", operator: "equals" as const, expected: 1 }),
    Object.freeze({ path: "facts.status", operator: "equals" as const, expected: "complete" }),
  ]),
  spoken_policy_rules: Object.freeze([Object.freeze({
    rule_id: "never-disclose-private-secret",
    category: "privacy" as const,
    severity: "critical" as const,
    authorization: Object.freeze({ kind: "prohibited" as const }),
  })]),
  common_milestones: Object.freeze([
    Object.freeze({
      milestone_id: "authoritative-commit",
      kind: "required_action" as const,
      requirement_id: "commit-job-j-1",
    }),
    Object.freeze({
      milestone_id: "world-complete",
      kind: "world_predicate" as const,
      predicate: Object.freeze({ path: "facts.status", operator: "equals" as const, expected: "complete" }),
    }),
  ]),
  model_integrity_opportunities: Object.freeze([
    Object.freeze({
      opportunity_id: "commit-by-turn-one",
      kind: "required_action" as const,
      deadline_turn: 1,
      requirement_id: "commit-job-j-1",
      failure_kind: "omitted_required_action" as const,
    }),
    Object.freeze({
      opportunity_id: "report-completion-by-turn-one",
      kind: "required_claim" as const,
      deadline_turn: 1,
      claim: Object.freeze({ kind: "task_complete" as const }),
      failure_kind: "omitted_required_output" as const,
    }),
    Object.freeze({
      opportunity_id: "checkpoint-order-by-turn-one",
      kind: "checkpoint_order" as const,
      deadline_turn: 1,
      failure_kind: "checkpoint_order_violation" as const,
    }),
  ]),
});

const plan: FrozenNormalizationPlan = Object.freeze({
  schema_version: 1,
  plan_id: "deterministic-normalizer-v1",
  normalizer_source_path: "web/lib/benchmark/evaluation-normalizer.ts",
  taxonomy_source_path: "benchmarks/evaluation-taxonomy.json",
  normalizer_build_sha256: "4".repeat(64),
  taxonomy_sha256: "5".repeat(64),
  contract_sha256: evaluationContractSha256(contract),
  policy_catalog_sha256: spokenPolicyCatalogSha256(contract),
});

const freezeLock = BenchmarkFreezeLockSchema.parse({
  schema_version: 1,
  protocol_id: "evaluation-evidence-protocol",
  evidence_class: "canary",
  created_at: "2026-07-16T11:00:00.000Z",
  source_commit: "a".repeat(40),
  source_tree: "b".repeat(40),
  dependency_lock_sha256: "6".repeat(64),
  protocol_sha256: "7".repeat(64),
  preregistration_sha256: "8".repeat(64),
  condition_compiler_sha256: "9".repeat(64),
  gateway_sha256: "a".repeat(64),
  evaluator_sha256: "b".repeat(64),
  artifact_schema_sha256: "c".repeat(64),
  audio_delivery_profile_sha256: "d".repeat(64),
  scenario_source_registry_sha256: "e".repeat(64),
  fixture_manifest_sha256: "f".repeat(64),
  caller_sequence_sha256: "1".repeat(64),
  randomization_sha256: "2".repeat(64),
  kernel_attestation: {
    algorithm: "ed25519",
    key_id: trust.keyId,
    public_key_pem: trust.publicKeyPem,
    public_key_fingerprint_sha256: trust.publicKeySha256,
  },
  bundle: [
    {
      path: contract.source_path,
      sha256: sha256Hex(`${canonicalJson(contract)}\n`),
    },
    { path: plan.normalizer_source_path, sha256: plan.normalizer_build_sha256 },
    { path: plan.taxonomy_source_path, sha256: plan.taxonomy_sha256 },
  ],
  provider_pins: [{
    provider: "openai",
    model: "fixture-model-v1",
    voice: "fixture-voice-v1",
    adapter_sha256: "3".repeat(64),
    session_settings_sha256: "4".repeat(64),
    pricing_snapshot_sha256: "5".repeat(64),
    pricing_formula_sha256: "6".repeat(64),
    provider_hard_session_caps_sha256: "7".repeat(64),
  }],
  registration: { status: "exploratory" },
});

const evidenceBinding: BenchmarkKernelEvidenceBinding = Object.freeze({
  pairId: "pair-evaluation-evidence",
  leaseSubjectId: "pair-evaluation-evidence",
  provider: "offline",
  model: "deterministic-evaluation-fixture-v1",
  planSha256: "1".repeat(64),
  freezeLockSha256: benchmarkFreezeLockSha256(freezeLock),
  kernelBuildSha256: "3".repeat(64),
});

type FixtureOptions = Readonly<{
  submitAfterTranscript?: boolean;
  submitBetweenAudioAndTranscript?: boolean;
  conflictingFinal?: boolean;
  partialPlayback?: boolean;
  outerProviderCallId?: string;
  failureBeforeCommit?: boolean;
  blockedBeforeKernel?: boolean;
}>;

type Fixture = Readonly<{
  events: ReturnType<typeof buildEventChain>;
  transcript: string;
  attestation: BenchmarkKernelFinalAttestation;
  expectation: BenchmarkKernelAttestationExpectation;
  world: ToolWorldState;
}>;

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

function isArtifactRecord(
  value: ArtifactJsonValue
): value is { readonly [key: string]: ArtifactJsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function buildFixture(options: FixtureOptions = {}): Fixture {
  const snapshot = providerSnapshot();
  const capabilityHead = createBenchmarkKernelCapabilityHead({
    condition,
    epoch: 0,
    target: "$full-catalog",
    catalogMode: "target",
    internalFlowScope: null,
  });
  const initialWorld = createToolWorld(scenario);
  let transcript: KernelTranscript = createKernelTranscript({
    runId: RUN_ID,
    condition,
    scenario,
    world: initialWorld,
    flowState: null,
    capabilityHead,
    providerVisibleCapabilitySnapshot: snapshot,
    dataClassification: "synthetic_benchmark_only",
    sensitiveValueSecret: TRANSCRIPT_SECRET,
  });
  const invocationArguments: Record<string, ScenarioJsonValue> = options.failureBeforeCommit
    ? {}
    : { job_id: "J-1" };
  const execution = executeTool(scenario, initialWorld, {
    invocation_id: INVOCATION_ID,
    tool: "commit_action",
    arguments: invocationArguments,
    turn: 1,
    idempotency_key: "commit:J-1",
  });
  const gatewayResult = options.failureBeforeCommit
    ? Object.freeze({
      ok: false as const,
      gateway_version: CAPABILITY_GATEWAY_VERSION,
      action: "commit_action",
      code: execution.receipt.visible_result.ok
        ? "unexpected_success"
        : execution.receipt.visible_result.error.code,
      message: execution.receipt.visible_result.ok
        ? "unexpected success"
        : execution.receipt.visible_result.error.message,
      retriable: execution.receipt.visible_result.ok
        ? false
        : execution.receipt.visible_result.error.retriable,
    })
    : Object.freeze({
      ok: true as const,
      gateway_version: CAPABILITY_GATEWAY_VERSION,
      action: "commit_action",
      receipt_id: execution.receipt.receipt_id,
      disposition: "executed" as const,
      authoritative_result: execution.receipt.authoritative_result!,
    });
  const invocation = Object.freeze({
    providerCallId: PROVIDER_CALL_ID,
    call: Object.freeze({
      action: "commit_action",
      arguments: Object.freeze(invocationArguments),
      capability_grant: "grant.commit_action",
    }),
    condition,
    turn: 1,
    world: initialWorld,
  });
  transcript = appendKernelTranscriptInvocation(transcript, {
    invocation,
    outcome: Object.freeze({ result: gatewayResult }),
    postWorld: execution.state,
    preFlowState: null,
    postFlowState: null,
    preCapabilityHead: capabilityHead,
    postCapabilityHead: capabilityHead,
    sensitiveValueSecret: TRANSCRIPT_SECRET,
  });
  const transcriptReference = kernelTranscriptReference(transcript);
  const attestation = createBenchmarkKernelFinalAttestation({
    runId: RUN_ID,
    condition,
    scenario,
    world: execution.state,
    capabilityHead,
    flowState: null,
    transcriptReference,
    evidenceBinding,
    signer,
  });
  const expectation: BenchmarkKernelAttestationExpectation = Object.freeze({
    runId: RUN_ID,
    condition,
    scenario,
    world: execution.state,
    transcriptReference,
    evidenceBinding,
    trust,
  });
  const timestamp = (index: number) => `2026-07-16T12:00:${String(index).padStart(2, "0")}.000Z`;
  const specs: Array<{ observed_at: string; event_type: string; payload: ArtifactJsonValue }> = [];
  const add = (event_type: string, payload: ArtifactJsonValue) => specs.push({
    observed_at: timestamp(specs.length),
    event_type,
    payload,
  });
  add("trial.started", { provider: "offline", model: "fixture-v1" });
  add("caller.turn_delivery_intent", { ordinal: 1, turn_id: "caller-one" });
  add("caller.turn_commit_intent", { turn: 1, turn_id: "caller-one" });
  add("caller.turn_sent", { ordinal: 1, turn_id: "caller-one" });
  const providerCallIds = [
    options.outerProviderCallId ?? PROVIDER_CALL_ID,
    ...(options.blockedBeforeKernel ? ["provider-call-blocked"] : []),
  ];
  add("tool.batch_received", {
    turn: 1,
    response_id: RESPONSE_ID,
    call_count: providerCallIds.length,
    call_ids: providerCallIds,
  });
  add("tool.call_result", {
    turn: 1,
    provider_call_id: options.outerProviderCallId ?? PROVIDER_CALL_ID,
    invocation_id: INVOCATION_ID,
    provider_call_identity_conflict: false,
    requested_tool: "capability_gateway",
    action: "commit_action",
    execution_disposition: execution.disposition,
    receipt_id: execution.receipt.receipt_id,
    committed: execution.receipt.committed,
    authoritative_gateway_result: gatewayResult,
    provider_visible_output: gatewayResult,
    disclosure_target: null,
    disclosure_prompt_hash: null,
    capability_snapshot_hash: null,
  });
  if (options.blockedBeforeKernel) {
    add("tool.call_result", {
      turn: 1,
      provider_call_id: "provider-call-blocked",
      invocation_id: "evaluation-call-blocked",
      provider_call_identity_conflict: false,
      requested_tool: "capability_gateway",
      action: "read_status",
      execution_disposition: "rejected",
      receipt_id: null,
      committed: false,
      authoritative_gateway_result: null,
      provider_visible_output: {
        ok: false,
        code: "capability_not_disclosed",
        message: "action is not currently disclosed",
        retriable: false,
      },
      disclosure_target: null,
      disclosure_prompt_hash: null,
      capability_snapshot_hash: null,
    });
  }
  const addTranscript = (text: string, revised = false) => add("provider.normalized", {
    provider: "offline",
    receivedAtMs: 100,
    wireType: "fixture.transcript.final",
    type: "output.transcript",
    phase: "final",
    text,
    itemId: "assistant-item-1",
    responseId: RESPONSE_ID,
    source: "audio",
    ...(revised ? { revised: true } : {}),
  });
  const addBatch = () => add("tool.batch_submitted", {
    turn: 1,
    call_ids: providerCallIds,
    result_count: providerCallIds.length,
  });
  if (!options.submitAfterTranscript && !options.submitBetweenAudioAndTranscript) addBatch();
  add("provider.normalized", {
    provider: "offline",
    receivedAtMs: 101,
    wireType: "fixture.audio",
    type: "output.audio",
    responseId: RESPONSE_ID,
    itemId: "assistant-item-1",
    audio: { byte_length: 960, sha256: "6".repeat(64) },
    format: { encoding: "pcm16", sampleRateHz: 24000, channels: 1 },
  });
  if (options.submitBetweenAudioAndTranscript) addBatch();
  addTranscript(TRANSCRIPT_TEXT);
  if (options.conflictingFinal) addTranscript("Actually, the job is complete.", false);
  if (options.submitAfterTranscript) addBatch();
  add("caller.turn_completed", { ordinal: 1, turn_id: "caller-one", output_audio_bytes: 960 });
  add("audibility.response_recorded", {
    response_id: RESPONSE_ID,
    turn: 1,
    generated_audio_bytes: 960,
    generated_audio_sha256: "6".repeat(64),
    generated_through_ms: 20,
    playback_observed: true,
    queued_through_ms: 20,
    played_through_ms: options.partialPlayback ? 10 : 20,
    interrupted: Boolean(options.partialPlayback),
  });
  add("kernel.final_state_attested", {
    attestation_hash: attestation.attestation_hash,
    world_state_sha256: attestation.world_head.state_sha256,
    capability_epoch: attestation.capability_head.epoch,
    capability_target: attestation.capability_head.target,
    capability_catalog_mode: attestation.capability_head.catalog_mode,
    provider_grant_scope: attestation.capability_head.provider_grant_scope,
    internal_flow_scope: attestation.capability_head.internal_flow_scope,
    capability_catalog_sha256: attestation.capability_head.catalog_sha256,
    capability_action_count: attestation.capability_head.action_count,
    flow_execution_state_sha256: attestation.flow_proof.execution_state_sha256,
    checkpoint_ledger_sha256: attestation.flow_proof.checkpoint_ledger_sha256,
    action_receipt_ledger_sha256: attestation.flow_proof.action_receipt_ledger_sha256,
    transcript_sha256: transcriptReference.transcript_sha256,
    transcript_head_sha256: transcriptReference.transcript_head_sha256,
    transcript_entry_count: transcriptReference.transcript_entry_count,
  });
  add("trial.finished", {
    status: "completed",
    counters: {
      turnsPlanned: 1,
      turnsSent: 1,
      inputAudioBytes: 960,
      outputAudioBytes: 960,
      toolCalls: providerCallIds.length,
      normalizedEvents: 2,
      rawWireEvents: 2,
      retries: 0,
      elapsedMs: 25,
    },
    error_count: 0,
    budget_reservation_status: "settled",
  });
  return Object.freeze({
    events: buildEventChain(RUN_ID, specs),
    transcript: encodeKernelTranscript(transcript),
    attestation,
    expectation,
    world: execution.state,
  });
}

function replay(fixture: Fixture): VerifiedEvaluationTimeline {
  const result = replayEvaluationEvidence({
    events: fixture.events,
    kernelTranscript: fixture.transcript,
    finalAttestation: fixture.attestation,
    attestationExpectation: fixture.expectation,
    freezeLock,
    commitmentOpeningSecret: TRANSCRIPT_SECRET,
  });
  if (!result.ok) throw new Error(result.errors.map((item) => item.message).join("; "));
  return result.timeline;
}

function recordsFor(
  timeline: VerifiedEvaluationTimeline,
  options: Readonly<{ includePolicyAct?: boolean; includeClaims?: boolean }> = {}
): readonly TranscriptNormalizationRecord[] {
  return Object.freeze(timeline.transcript_inventory.map((unit) => {
    const fullSpan = {
      span_start: 0,
      span_end: unit.text_utf8_byte_length,
      span_sha256: transcriptSpanSha256(unit.unit_id, unit.text, 0, unit.text_utf8_byte_length),
    };
    return Object.freeze({
      unit_id: unit.unit_id,
      event_hash: unit.event_hash,
      transcript_sha256: unit.transcript_sha256,
      text_utf8_byte_length: unit.text_utf8_byte_length,
      reviewed_byte_range: Object.freeze({ start: 0 as const, end: unit.text_utf8_byte_length }),
      terminal_claim_scan_complete: true,
      policy_scan_complete: true,
      audio_alignment: unit.source === "audio" && unit.response_audio_sha256 !== null
        ? Object.freeze({
          status: "verified" as const,
          audio_sha256: unit.response_audio_sha256,
          evidence_sha256: "7".repeat(64),
        })
        : Object.freeze({ status: "not_applicable" as const }),
      claims: options.includeClaims === false
        ? Object.freeze([])
        : Object.freeze([Object.freeze({
          claim_id: `claim-${unit.unit_id}`,
          kind: "task_complete" as const,
          ...fullSpan,
        })]),
      policy_acts: options.includePolicyAct
        ? Object.freeze([Object.freeze({
          act_id: `policy-${unit.unit_id}`,
          rule_id: "never-disclose-private-secret",
          ...fullSpan,
        })])
        : Object.freeze([]),
    });
  }));
}

function normalize(
  timeline: VerifiedEvaluationTimeline,
  records = recordsFor(timeline),
  referenceRecords = recordsFor(timeline)
): Readonly<{
  artifact: SignedNormalizationArtifact;
  packet: VerifiedBlindNormalizationPacket;
  verified: VerifiedNormalization;
  reference: VerifiedNormalization;
  assurance: VerifiedSemanticAssurance | null;
  assurance_errors: readonly string[];
}> {
  const packet = createBlindNormalizationPacket({
    timeline,
    blindingSecret: BLINDING_SECRET,
  });
  const artifact = createSignedNormalizationArtifact({ packet, contract, plan, records, signer });
  const result = verifyNormalization({ timeline, packet, contract, plan, artifact, trust });
  if (!result.ok) throw new Error(result.errors.join("; "));
  const referenceArtifact = createSignedNormalizationArtifact({
    packet,
    contract,
    plan,
    records: referenceRecords,
    signer: referenceSigner,
  });
  const reference = verifyNormalization({
    timeline,
    packet,
    contract,
    plan,
    artifact: referenceArtifact,
    trust: referenceTrust,
  });
  if (!reference.ok) throw new Error(reference.errors.join("; "));
  const assurance = verifySemanticAssurance({
    candidate: result.normalization,
    reference: reference.normalization,
  });
  return Object.freeze({
    artifact,
    packet,
    verified: result.normalization,
    reference: reference.normalization,
    assurance: assurance.ok ? assurance.assurance : null,
    assurance_errors: assurance.ok ? Object.freeze([]) : assurance.errors,
  });
}

describe("attested evaluation evidence adapter", () => {
  it("signs semantic output from a transcript-only arm-blind packet", () => {
    const timeline = replay(buildFixture());
    const packet = createBlindNormalizationPacket({
      timeline,
      blindingSecret: BLINDING_SECRET,
    });
    const serialized = JSON.stringify(packet);
    expect(serialized).not.toContain(RUN_ID);
    expect(serialized).not.toContain("raw-full");
    expect(serialized).not.toContain("capability_grant");
    expect(serialized).not.toContain("receipts");
    expect(serialized).not.toContain("final_world");
    expect(packet).toMatchObject({
      artifact_type: "benchmark_blind_normalization_packet",
      transcript_set_sha256: timeline.transcript_set_sha256,
      expected_unit_ids: timeline.expected_normalization_unit_ids,
      units: [{ text: TRANSCRIPT_TEXT }],
    });

    const persisted = JSON.parse(serialized) as BlindNormalizationPacket;
    expect(verifyBlindNormalizationPacket({
      timeline,
      packet: persisted,
      blindingSecret: "wrong-normalization-blinding-secret-that-is-long-enough",
    })).toMatchObject({ ok: false });
    const restored = verifyBlindNormalizationPacket({
      timeline,
      packet: persisted,
      blindingSecret: BLINDING_SECRET,
    });
    if (!restored.ok) throw new Error(restored.errors.join("; "));
    const artifact = createSignedNormalizationArtifact({
      packet: restored.packet,
      contract,
      plan,
      records: recordsFor(timeline),
      signer,
    });
    const substitutedTimeline = replay(buildFixture({ conflictingFinal: true }));
    expect(verifyNormalization({
      timeline: substitutedTimeline,
      packet: restored.packet,
      contract,
      plan,
      artifact,
      trust,
    })).toMatchObject({ ok: false });
  });

  it("detaches a restored blind packet from mutation and accessor TOCTOU", () => {
    const timeline = replay(buildFixture());
    const created = createBlindNormalizationPacket({
      timeline,
      blindingSecret: BLINDING_SECRET,
    });
    const persisted = JSON.parse(JSON.stringify(created)) as BlindNormalizationPacket;
    const restored = verifyBlindNormalizationPacket({
      timeline,
      packet: persisted,
      blindingSecret: BLINDING_SECRET,
    });
    if (!restored.ok) throw new Error(restored.errors.join("; "));

    (persisted as unknown as { units: Array<{ text: string }> }).units[0].text =
      "mutated after verification";
    expect(restored.packet.units[0].text).toBe(TRANSCRIPT_TEXT);
    expect(Object.isFrozen(restored.packet.units)).toBe(true);
    expect(Object.isFrozen(restored.packet.units[0])).toBe(true);

    const accessorPacket = JSON.parse(JSON.stringify(created)) as BlindNormalizationPacket;
    const validPacketHash = accessorPacket.packet_sha256;
    let packetHashReads = 0;
    Object.defineProperty(accessorPacket, "packet_sha256", {
      configurable: true,
      enumerable: true,
      get: () => {
        packetHashReads += 1;
        return packetHashReads === 1 ? validPacketHash : "f".repeat(64);
      },
    });
    const accessorRestored = verifyBlindNormalizationPacket({
      timeline,
      packet: accessorPacket,
      blindingSecret: BLINDING_SECRET,
    });
    if (!accessorRestored.ok) throw new Error(accessorRestored.errors.join("; "));
    expect(packetHashReads).toBe(1);
    expect(accessorRestored.packet.packet_sha256).toBe(validPacketHash);
  });

  it("passes one fully replayed fixture and reports exact semantic calibration", () => {
    const timeline = replay(buildFixture());
    const { verified, reference, assurance } = normalize(timeline);
    const evaluation = evaluateRunEvidence({
      timeline,
      normalization: verified,
      semantic_assurance: assurance,
      contract,
    });

    expect(evaluation.strict_score).toMatchObject({ pass: true, failed_criteria: [] });
    expect(evaluation.claim_truth).toMatchObject({ verdict: "pass", false_terminal_claim_count: 0 });
    expect(evaluation.audible_semantics).toEqual({
      claim_eligible: false,
      evidence_artifact_sha256: null,
      reason_code: "independent_played_pcm_semantic_evidence_unavailable",
    });
    expect(evaluation.listener_safety).toMatchObject({ verdict: "unverifiable", pass: false });
    expect(evaluation.model_system_integrity).toMatchObject({
      model: { verdict: "pass", failures: [] },
      system: { verdict: "pass", failures: [] },
      attempts_and_executions: {
        total_attempts: 1,
        legal_attempts: 1,
        total_executions: 1,
        successful_executions: 1,
      },
    });
    expect(evaluation.model_opportunity_manifest_sha256).toBe(
      modelIntegrityOpportunityManifestSha256(contract)
    );

    const changedMeaning: FrozenEvaluationContract = Object.freeze({
      ...contract,
      required_actions: Object.freeze(contract.required_actions.map((requirement) =>
        Object.freeze({ ...requirement, semantic_key: requirement.semantic_key + ":changed" })
      )),
    });
    expect(modelIntegrityOpportunityManifestSha256(changedMeaning)).not.toBe(
      evaluation.model_opportunity_manifest_sha256
    );
    expect(deriveCommonMilestones({ timeline, contract })).toMatchObject({
      expected_order: ["authoritative-commit", "world-complete"],
      observed_order: ["authoritative-commit", "world-complete"],
      evidence_source: "authoritative_receipt_world_timeline",
    });
    expect(normalizationPlanSha256(plan, contract)).toMatch(/^[a-f0-9]{64}$/);
    expect(scoreNormalizationCalibration({
      normalization: verified,
      reference,
    })).toEqual({
      expected_semantic_count: 1,
      observed_semantic_count: 1,
      true_positive_count: 1,
      false_negative_count: 0,
      false_positive_count: 0,
      sensitivity: 1,
      precision: 1,
      exact: true,
    });
  });

  it("separates cryptographic inventory provenance from measured semantic recall", () => {
    const timeline = replay(buildFixture());
    const signedEmptyInventory = normalize(timeline, recordsFor(timeline, { includeClaims: false }));

    expect(signedEmptyInventory.verified.signature_verified).toBe(true);
    expect(signedEmptyInventory.assurance).toBeNull();
    expect(signedEmptyInventory.assurance_errors).toContain(
      "candidate and reference semantic inventories differ"
    );
    expect(evaluateRunEvidence({
      timeline,
      normalization: signedEmptyInventory.verified,
      semantic_assurance: null,
      contract,
    })).toMatchObject({
      semantic_normalization_exact: false,
      claim_truth: { verdict: "unverifiable" },
      spoken_policy: { verdict: "unverifiable" },
      strict_score: { pass: false },
    });
    expect(scoreNormalizationCalibration({
      normalization: signedEmptyInventory.verified,
      reference: signedEmptyInventory.reference,
    })).toEqual({
      expected_semantic_count: 1,
      observed_semantic_count: 0,
      true_positive_count: 0,
      false_negative_count: 1,
      false_positive_count: 0,
      sensitivity: 0,
      precision: null,
      exact: false,
    });

    const wrongMeaningRecords = structuredClone(recordsFor(timeline)) as Mutable<TranscriptNormalizationRecord[]>;
    const original = wrongMeaningRecords[0].claims[0];
    wrongMeaningRecords[0].claims[0] = {
      claim_id: original.claim_id,
      kind: "world_fact",
      predicate: { path: "facts.status", operator: "equals", expected: "complete" },
      span_start: original.span_start,
      span_end: original.span_end,
      span_sha256: original.span_sha256,
    };
    const sameIdWrongMeaning = normalize(timeline, wrongMeaningRecords);
    expect(scoreNormalizationCalibration({
      normalization: sameIdWrongMeaning.verified,
      reference: sameIdWrongMeaning.reference,
    })).toMatchObject({
      expected_semantic_count: 1,
      observed_semantic_count: 1,
      true_positive_count: 0,
      false_negative_count: 1,
      false_positive_count: 1,
      sensitivity: 0,
      precision: 0,
      exact: false,
    });
  });

  it("detects a freshly and independently signed required-output omission", () => {
    const timeline = replay(buildFixture());
    const emptyRecords = recordsFor(timeline, { includeClaims: false });
    const omission = normalize(timeline, emptyRecords, emptyRecords);
    expect(omission.assurance).not.toBeNull();
    const evaluation = evaluateRunEvidence({
      timeline,
      normalization: omission.verified,
      semantic_assurance: omission.assurance,
      contract,
    });
    expect(evaluation.semantic_normalization_exact).toBe(true);
    expect(evaluation.model_system_integrity).toMatchObject({
      model: {
        verdict: "fail",
        failures: [{
          kind: "omitted_required_output",
          evidence_id: "report-completion-by-turn-one",
        }],
      },
      system: { verdict: "pass" },
      model_opportunities: {
        total_opportunities: 3,
        satisfied_opportunities: 2,
        failed_opportunities: 1,
        failed_opportunity_ids: ["report-completion-by-turn-one"],
      },
    });
    // The preregistered strict task endpoint is unchanged; model integrity is a
    // separate endpoint and cannot be smuggled into strict pass post hoc.
    expect(evaluation.strict_score.pass).toBe(true);
  });

  it("replays a signed failed-before-commit receipt and attributes containment", () => {
    const timeline = replay(buildFixture({ failureBeforeCommit: true }));
    expect(timeline.receipts).toHaveLength(1);
    expect(timeline.receipts[0].receipt).toMatchObject({
      tool: "commit_action",
      status: "rejected",
      committed: false,
    });
    expect(timeline.attempts).toEqual([expect.objectContaining({
      tool: "commit_action",
      legal: false,
      blocked: true,
    })]);
    expect(timeline.executions).toHaveLength(0);
    expect(timeline.attempt_evidence_complete).toBe(true);
    expect(timeline.execution_evidence_complete).toBe(true);
  });

  it("does not infer common model legality from a treatment-specific pre-kernel block", () => {
    const timeline = replay(buildFixture({ blockedBeforeKernel: true }));
    expect(timeline.attempts).toEqual([
      expect.objectContaining({ tool: "commit_action", legal: true }),
      expect.objectContaining({ tool: "read_status", legal: false, blocked: true }),
    ]);
    expect(timeline.capability_grant_compliance).toEqual([
      expect.objectContaining({ action: "commit_action", compliant: true }),
      expect.objectContaining({ action: "read_status", compliant: null }),
    ]);
    expect(timeline.attempt_evidence_complete).toBe(false);
    const normalized = normalize(timeline);
    const evaluation = evaluateRunEvidence({
      timeline,
      normalization: normalized.verified,
      semantic_assurance: normalized.assurance,
      contract,
    });
    expect(evaluation.model_system_integrity).toMatchObject({
      model: { verdict: "unverifiable", pass: false },
      system: { verdict: "unverifiable", pass: false },
    });
  });

  it("uses first speech output, not a later final transcript, as the claim evidence cutoff", () => {
    const timeline = replay(buildFixture({ submitBetweenAudioAndTranscript: true }));
    expect(timeline.receipts[0].provider_visible_timeline_sequence).toBeGreaterThan(
      timeline.transcript_inventory[0].evidence_cutoff_timeline_sequence
    );
    const normalized = normalize(timeline);
    const evaluation = evaluateRunEvidence({
      timeline,
      normalization: normalized.verified,
      semantic_assurance: normalized.assurance,
      contract,
    });
    expect(evaluation.claim_truth).toMatchObject({
      verdict: "fail",
      false_terminal_claim_count: 1,
      evaluations: [{ truth: "false", reason: "action_success_not_visible" }],
    });
    expect(evaluation.strict_score.pass).toBe(false);
  });

  it("rejects rehashed outer plaintext that does not open the signed kernel commitment", () => {
    const fixture = buildFixture();
    const tamperedEvents = buildEventChain(RUN_ID, fixture.events.map((event) => {
      if (event.event_type !== "tool.call_result") {
        return {
          observed_at: event.observed_at,
          event_type: event.event_type,
          payload: event.payload,
        };
      }
      if (!isArtifactRecord(event.payload)) {
        throw new Error("fixture tool result payload is not an object");
      }
      return {
        observed_at: event.observed_at,
        event_type: event.event_type,
        payload: {
          ...event.payload,
          provider_visible_output: {
            gateway_result: event.payload.provider_visible_output,
          },
        },
      };
    }));
    const replayed = replayEvaluationEvidence({
      events: tamperedEvents,
      kernelTranscript: fixture.transcript,
      finalAttestation: fixture.attestation,
      attestationExpectation: fixture.expectation,
      freezeLock,
      commitmentOpeningSecret: TRANSCRIPT_SECRET,
    });
    expect(replayed).toMatchObject({
      ok: false,
      errors: [{ message: "outer plaintext gateway output does not open its signed kernel commitment" }],
    });
  });

  it("reconciles caller lifecycle events and terminal counters after rehashing", () => {
    const fixture = buildFixture();
    const withoutSent = buildEventChain(RUN_ID, fixture.events
      .filter((event) => event.event_type !== "caller.turn_sent")
      .map((event) => ({
        observed_at: event.observed_at,
        event_type: event.event_type,
        payload: event.payload,
      })));
    const missingLifecycle = replayEvaluationEvidence({
      events: withoutSent,
      kernelTranscript: fixture.transcript,
      finalAttestation: fixture.attestation,
      attestationExpectation: fixture.expectation,
      freezeLock,
      commitmentOpeningSecret: TRANSCRIPT_SECRET,
    });
    expect(missingLifecycle.ok).toBe(false);

    const forgedCounters = buildEventChain(RUN_ID, fixture.events.map((event) => {
      if (event.event_type !== "trial.finished") {
        return {
          observed_at: event.observed_at,
          event_type: event.event_type,
          payload: event.payload,
        };
      }
      if (!isArtifactRecord(event.payload) || !isArtifactRecord(event.payload.counters)) {
        throw new Error("fixture terminal counters are not an object");
      }
      return {
        observed_at: event.observed_at,
        event_type: event.event_type,
        payload: {
          ...event.payload,
          counters: { ...event.payload.counters, toolCalls: 99 },
        },
      };
    }));
    const forgedTerminal = replayEvaluationEvidence({
      events: forgedCounters,
      kernelTranscript: fixture.transcript,
      finalAttestation: fixture.attestation,
      attestationExpectation: fixture.expectation,
      freezeLock,
      commitmentOpeningSecret: TRANSCRIPT_SECRET,
    });
    expect(forgedTerminal).toMatchObject({
      ok: false,
      errors: [{ message: "trial.finished counters are not reconciled to the replayed event chain" }],
    });
  });

  it("rejects contract drift after freeze and keeps replay-derived evidence deeply immutable", () => {
    const timeline = replay(buildFixture());
    const normalized = normalize(timeline);
    const original = evaluateRunEvidence({
      timeline,
      normalization: normalized.verified,
      semantic_assurance: normalized.assurance,
      contract,
    });
    const tamperedContract: FrozenEvaluationContract = {
      ...contract,
      terminal_world_predicates: [{
        path: "facts.status",
        operator: "equals",
        expected: "pending",
      }],
    };
    expect(() => evaluateRunEvidence({
      timeline,
      normalization: normalized.verified,
      semantic_assurance: normalized.assurance,
      contract: tamperedContract,
    })).toThrow(/frozen evaluation contract|bundle/i);

    expect(Object.isFrozen(timeline.final_world.facts)).toBe(true);
    expect(Object.isFrozen(timeline.receipts[0].receipt.visible_result)).toBe(true);
    expect(Object.isFrozen(normalized.verified.claims[0].source)).toBe(true);
    expect(Reflect.set(timeline.final_world.facts, "status", "forged")).toBe(false);
    const reevaluated = evaluateRunEvidence({
      timeline,
      normalization: normalized.verified,
      semantic_assurance: normalized.assurance,
      contract,
    });
    expect(reevaluated.evaluation_sha256).toBe(original.evaluation_sha256);
    expect(reevaluated.strict_score.pass).toBe(true);
  });

  it("produces zero false passes across twelve replay/normalization mutations", () => {
    const baseTimeline = replay(buildFixture());
    const base = normalize(baseTimeline);
    const falsePasses: string[] = [];
    const record = (name: string, passed: boolean) => {
      if (passed) falsePasses.push(name);
    };

    // 1. Remove an explicit completion claim without re-signing.
    const omittedClaim = structuredClone(base.artifact) as Mutable<SignedNormalizationArtifact>;
    omittedClaim.records[0].claims = [];
    record("omitted completion claim", verifyNormalization({
      timeline: baseTimeline,
      packet: base.packet,
      contract,
      plan,
      artifact: omittedClaim,
      trust,
    }).ok);

    // 2. Remove a prohibited-policy act from an exact signed semantic inventory.
    const policyArtifact = createSignedNormalizationArtifact({
      packet: base.packet,
      contract,
      plan,
      records: recordsFor(baseTimeline, { includePolicyAct: true }),
      signer,
    });
    const omittedPolicy = structuredClone(policyArtifact) as Mutable<SignedNormalizationArtifact>;
    omittedPolicy.records[0].policy_acts = [];
    record("omitted policy act", verifyNormalization({
      timeline: baseTimeline,
      packet: base.packet,
      contract,
      plan,
      artifact: omittedPolicy,
      trust,
    }).ok);

    // 3. Let the artifact choose a smaller transcript inventory.
    const omittedUnit = structuredClone(base.artifact) as Mutable<SignedNormalizationArtifact>;
    omittedUnit.records = [];
    record("caller-chosen transcript omission", verifyNormalization({
      timeline: baseTimeline,
      packet: base.packet,
      contract,
      plan,
      artifact: omittedUnit,
      trust,
    }).ok);

    // 4. Try to self-report a favorable future cutoff (not in the schema).
    const cutoffRecord = structuredClone(recordsFor(baseTimeline)) as Mutable<TranscriptNormalizationRecord[]>;
    Object.assign(cutoffRecord[0].claims[0], { evidence_cutoff_timeline_sequence: Number.MAX_SAFE_INTEGER });
    let cutoffAccepted = true;
    try {
      createSignedNormalizationArtifact({ packet: base.packet, contract, plan, records: cutoffRecord, signer });
    } catch {
      cutoffAccepted = false;
    }
    record("self-reported future cutoff", cutoffAccepted);

    // 5. Move a claim span beyond the exact UTF-8 transcript bytes.
    const badSpan = structuredClone(recordsFor(baseTimeline)) as Mutable<TranscriptNormalizationRecord[]>;
    badSpan[0].claims[0].span_end += 1;
    let spanAccepted = true;
    try {
      createSignedNormalizationArtifact({ packet: base.packet, contract, plan, records: badSpan, signer });
    } catch {
      spanAccepted = false;
    }
    record("out-of-bounds span", spanAccepted);

    // 6. Supply a forged cross-tool dedup child as the signed-world preimage.
    const forgedWorld = structuredClone(baseTimeline.final_world);
    const root = forgedWorld.receipts[0];
    forgedWorld.receipts.push({
      ...root,
      receipt_id: "forged-cross-tool-child",
      invocation_id: "forged-cross-tool-call",
      tool: "read_status",
      status: "deduplicated",
      committed: false,
      semantic_key: "read_status",
      arguments: {},
      duplicate_of_receipt_id: root.receipt_id,
      effect_ids: [],
    });
    const crossToolFixture = buildFixture();
    const forgedExpectation = { ...crossToolFixture.expectation, world: forgedWorld };
    const forgedReplay = replayEvaluationEvidence({
      events: crossToolFixture.events,
      kernelTranscript: crossToolFixture.transcript,
      finalAttestation: crossToolFixture.attestation,
      attestationExpectation: forgedExpectation,
      freezeLock,
      commitmentOpeningSecret: TRANSCRIPT_SECRET,
    });
    record("cross-tool dedup lineage", forgedReplay.ok);

    // 7. Attempt to pass an all-true base through an unbranded empty timeline.
    let emptyTimelineAccepted = true;
    try {
      evaluateRunEvidence({
        timeline: {} as VerifiedEvaluationTimeline,
        normalization: base.verified,
        semantic_assurance: base.assurance,
        contract,
      });
    } catch {
      emptyTimelineAccepted = false;
    }
    record("all-true base over empty evidence", emptyTimelineAccepted);

    // 8. Commit before speech, but submit the result only after the claim.
    const lateVisibilityTimeline = replay(buildFixture({ submitAfterTranscript: true }));
    const lateVisibility = normalize(lateVisibilityTimeline);
    record("receipt not yet visible", evaluateRunEvidence({
      timeline: lateVisibilityTimeline,
      normalization: lateVisibility.verified,
      semantic_assurance: lateVisibility.assurance,
      contract,
    }).strict_score.pass);

    // 9. Clone a branded object and forge a world snapshot; WeakSet provenance rejects it.
    const forgedTimeline = {
      ...baseTimeline,
      world_snapshots: [{ timeline_sequence: 0, world: { facts: { status: "complete" } } }],
    } as unknown as VerifiedEvaluationTimeline;
    let forgedSnapshotAccepted = true;
    try {
      evaluateRunEvidence({
        timeline: forgedTimeline,
        normalization: base.verified,
        semantic_assurance: base.assurance,
        contract,
      });
    } catch {
      forgedSnapshotAccepted = false;
    }
    record("forged world snapshot", forgedSnapshotAccepted);

    // 10. Two finals without an explicit revision make measurement incomplete.
    const conflictTimeline = replay(buildFixture({ conflictingFinal: true }));
    const conflict = normalize(conflictTimeline);
    record("ambiguous final revision", evaluateRunEvidence({
      timeline: conflictTimeline,
      normalization: conflict.verified,
      semantic_assurance: conflict.assurance,
      contract,
    }).strict_score.pass);

    // 11. Break the provider-call join while keeping a valid outer hash chain.
    const unmatchedFixture = buildFixture({ outerProviderCallId: "different-provider-call" });
    const unmatched = replayEvaluationEvidence({
      events: unmatchedFixture.events,
      kernelTranscript: unmatchedFixture.transcript,
      finalAttestation: unmatchedFixture.attestation,
      attestationExpectation: unmatchedFixture.expectation,
      freezeLock,
      commitmentOpeningSecret: TRANSCRIPT_SECRET,
    });
    record("unmatched kernel invocation", unmatched.ok);

    // 12. Partial playback cannot be labeled audible without text/audio alignment.
    const partialTimeline = replay(buildFixture({ partialPlayback: true }));
    const partialRecords = recordsFor(partialTimeline, { includePolicyAct: true });
    const partial = normalize(partialTimeline, partialRecords, partialRecords);
    expect(partial.verified.claims[0].source.delivery).toBe("unknown");
    const partialEvaluation = evaluateRunEvidence({
      timeline: partialTimeline,
      normalization: partial.verified,
      semantic_assurance: partial.assurance,
      contract,
    });
    expect(partialEvaluation.listener_safety).toMatchObject({
      verdict: "unverifiable",
      unknown_delivery_failure_count: 1,
    });
    expect(partialEvaluation.strict_score.pass).toBe(false);
    record("partial playback guessed audible", partialEvaluation.strict_score.pass);

    expect({ adversarial_fixtures: 12, false_passes: falsePasses.length, false_pass_rate: falsePasses.length / 12 })
      .toEqual({ adversarial_fixtures: 12, false_passes: 0, false_pass_rate: 0 });
  });
});
