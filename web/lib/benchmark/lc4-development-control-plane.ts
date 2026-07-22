import type { BenchmarkKernelAttestationSigner } from "./kernel-attestation";
import type { CapabilityGatewayResult, ProviderCapabilitySnapshot } from "./capability-gateway";

import { AgentFlowSchema, type AgentFlow } from "../flow";
import { canonicalJson, immutableJson, sha256Hex } from "./artifacts";
import {
  compileConditionSuite,
  type CompiledBenchmarkCondition,
  type CompiledConditionSuite,
} from "./condition-compiler";
import {
  createConversationalRepairPlan,
  createConversationalRepairState,
  type ConversationalRepairBlocker,
  type ConversationalRepairPlan,
  type ConversationalRepairState,
} from "./conversational-repair";
import { createInMemoryBenchmarkGatewayKernel, type InMemoryBenchmarkGatewayKernel } from "./gateway-kernel";
import type { BenchmarkKernelEvidenceBinding } from "./kernel-attestation";
import {
  createLc4AsyncWorkerService,
  type Lc4AsyncWorkerService,
  type Lc4WorkerJob,
  type Lc4WorkerSnapshot,
} from "./lc4-async-worker-service";
import {
  assertLc4DevAudioArtifacts,
  type Lc4DevAudioManifest,
  type Lc4DevRepairAudioManifest,
} from "./lc4-development-audio-materializer";
import type { Lc4DevExecutableMechanismControl } from "./lc4-development-live-dependencies";
import type {
  Lc4DevGatewayExecutor,
  Lc4DevGatewayExecutionInput,
} from "./lc4-development-gateway-bridge";
import type {
  Lc4DevControlReceipt,
  Lc4DevLiveEpisodePlan,
} from "./lc4-development-live-runner";
import {
  assertLc4PublicDevelopmentCorpus,
  createLc4PublicDevelopmentCorpus,
  type Lc4PublicDevelopmentCorpus,
  type Lc4PublicDevOpportunity,
} from "./lc4-public-development-corpus";
import { BenchmarkScenarioSchema, type BenchmarkScenario, type JsonValue } from "./scenario-schema";
import { createToolWorld, executeTool, type ToolWorldState } from "./tool-world";

const CONTROL_MANIFEST_DOMAIN = "harshas-amazing-call-center/lc4-dev-control-manifest/v1\n";
const CONTROL_RECEIPT_DOMAIN = "harshas-amazing-call-center/lc4-dev-control-receipt/v1\n";
const GATEWAY_EXECUTION_RECEIPT_DOMAIN = "harshas-amazing-call-center/lc4-dev-control-gateway-execution/v1\n";
const CONTINUITY_DOMAIN = "harshas-amazing-call-center/lc4-dev-arm-common-continuity/v1\n";
const NATIVE_TRANSCRIPT_DOMAIN = "harshas-amazing-call-center/lc4-dev-native-control-transcript/v1\n";
const NATIVE_CONTEXT_DOMAIN = "harshas-amazing-call-center/lc4-dev-native-context/v1\n";
const WORKER_PLAN_DOMAIN = "harshas-amazing-call-center/lc4-dev-worker-plan/v1\n";
const CONTROL_VERSION = "lc4-dev-municipal-control-plane-v1" as const;

const STAGES = Object.freeze([
  Object.freeze({ id: "stage.intake", step: "oral_history.intake", end: 10 }),
  Object.freeze({ id: "stage.eligibility", step: "oral_history.eligibility", end: 20 }),
  Object.freeze({ id: "stage.research-plan", step: "oral_history.research_plan", end: 30 }),
  Object.freeze({ id: "stage.booking", step: "oral_history.booking", end: 40 }),
  Object.freeze({ id: "stage.delivery", step: "oral_history.delivery", end: 50 }),
  Object.freeze({ id: "stage.closeout", step: "oral_history.closeout", end: 60 }),
] as const);

const CONTROL_TOOLS = Object.freeze([
  "archive.launch_worker",
  "archive.observe_worker_result",
  "archive.submit_transcript_request",
  "archive.reconcile_transcript_request",
  "archive.complete_stage",
  "archive.reserve_room",
] as const);

type Provider = Lc4DevLiveEpisodePlan["provider"];
type Arm = Lc4DevLiveEpisodePlan["arm"];

function freeze<T>(value: T): T {
  return immutableJson(value) as unknown as T;
}

function hash(domain: string, value: unknown): string {
  return sha256Hex(`${domain}${canonicalJson(value)}`);
}

function valueJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function toolResultFields(fields: Readonly<Record<string, { literal: JsonValue } | { source: "arguments" | "world" | "runtime"; path: string }>>) {
  return Object.entries(fields).map(([path, value]) => ({ path, value }));
}

function createScenario(corpus: Lc4PublicDevelopmentCorpus): BenchmarkScenario {
  const tools = [
    {
      name: "archive.launch_worker",
      description: "Commit one durable asynchronous worker launch request to the scenario ledger.",
      kind: "mutation" as const,
      arguments: [{ name: "launch", description: "Canonical launch envelope.", type: "object" as const, required: true }],
      additional_arguments: false,
      prerequisites: [],
      semantic_key: [{ source: "arguments" as const, path: "launch" }],
      duplicate_policy: "return_prior" as const,
      effects: [{ operation: "append" as const, path: "worker_launch_ledger", value: { source: "arguments" as const, path: "launch" }, description: "Append one authoritative worker launch." }],
      result: { fields: toolResultFields({ receipt_id: { source: "runtime", path: "invocation_id" }, launch: { source: "arguments", path: "launch" } }), tainted_paths: [] },
      faults: [],
    },
    {
      name: "archive.observe_worker_result",
      description: "Commit one accepted or rejected durable worker result disposition.",
      kind: "mutation" as const,
      arguments: [{ name: "observation", description: "Canonical worker-result disposition.", type: "object" as const, required: true }],
      additional_arguments: false,
      prerequisites: [],
      semantic_key: [{ source: "arguments" as const, path: "observation" }],
      duplicate_policy: "return_prior" as const,
      effects: [{ operation: "append" as const, path: "worker_result_ledger", value: { source: "arguments" as const, path: "observation" }, description: "Append one authoritative worker result disposition." }],
      result: { fields: toolResultFields({ receipt_id: { source: "runtime", path: "invocation_id" }, observation: { source: "arguments", path: "observation" } }), tainted_paths: [] },
      faults: [],
    },
    {
      name: "archive.submit_transcript_request",
      description: "Submit the corrected accessible-transcript request exactly once.",
      kind: "mutation" as const,
      arguments: [{ name: "request_id", description: "Stable transcript request identity.", type: "string" as const, required: true }],
      additional_arguments: false,
      prerequisites: [],
      semantic_key: [{ source: "arguments" as const, path: "request_id" }],
      duplicate_policy: "return_prior" as const,
      effects: [
        { operation: "increment" as const, path: "transcript_request_attempts", value: { literal: 1 }, description: "Count one authoritative transcript mutation." },
        { operation: "set" as const, path: "transcript_request_status", value: { literal: "committed" }, description: "Record the authoritative committed status." },
      ],
      result: { fields: toolResultFields({ request_id: { source: "arguments", path: "request_id" }, status: { literal: "committed" } }), tainted_paths: [] },
      faults: [{
        id: "transcript_timeout_after_commit",
        semantic_opportunity_id: "lc4-dev-op-35",
        phase: "after_commit" as const,
        when: [],
        visible_error: { code: "transport_timeout", message: "Transcript submission outcome is ambiguous until authoritative read-back.", retriable: false },
      }],
    },
    {
      name: "archive.reconcile_transcript_request",
      description: "Read back the exact transcript mutation by its original gateway invocation identity.",
      kind: "query" as const,
      arguments: [{ name: "invocation_id", description: "Original gateway-derived ToolWorld invocation identity.", type: "string" as const, required: true }],
      additional_arguments: false,
      prerequisites: [],
      semantic_key: [],
      duplicate_policy: "execute" as const,
      effects: [],
      result: { fields: toolResultFields({
        invocation_id: { source: "arguments", path: "invocation_id" },
        terminal: { source: "world", path: "transcript_request_status" },
        request_id: { literal: "lc4-dev-accessible-transcript" },
        status: { source: "world", path: "transcript_request_status" },
        "result.request_id": { literal: "lc4-dev-accessible-transcript" },
        "result.status": { source: "world", path: "transcript_request_status" },
      }), tainted_paths: [] },
      faults: [],
    },
    {
      name: "archive.complete_stage",
      description: "Checkpoint one exact ten-opportunity municipal oral-history stage.",
      kind: "mutation" as const,
      arguments: [{ name: "stage_id", description: "Frozen public-corpus stage identity.", type: "string" as const, required: true, enum: STAGES.map((stage) => stage.id) }],
      additional_arguments: false,
      prerequisites: [],
      semantic_key: [{ source: "arguments" as const, path: "stage_id" }],
      duplicate_policy: "return_prior" as const,
      effects: [{ operation: "append" as const, path: "completed_stage_ledger", value: { source: "arguments" as const, path: "stage_id" }, description: "Append the completed stage identity." }],
      result: { fields: toolResultFields({ stage_complete_receipt: { source: "runtime", path: "invocation_id" }, stage_id: { source: "arguments", path: "stage_id" } }), tainted_paths: [] },
      faults: [],
    },
    {
      name: "archive.reserve_room",
      description: "Reserve an archive room only after all authoritative prerequisites are true.",
      kind: "mutation" as const,
      arguments: [{ name: "reservation_id", description: "Stable reservation identity.", type: "string" as const, required: true }],
      additional_arguments: false,
      prerequisites: [
        { id: "rights_current", description: "Current-record rights evidence must be authoritative.", left: { source: "world" as const, path: "rights_authoritative" }, operator: "equals" as const, right: { literal: true } },
        { id: "eligibility_current", description: "Corrected-record eligibility evidence must be authoritative.", left: { source: "world" as const, path: "eligibility_authoritative" }, operator: "equals" as const, right: { literal: true } },
        { id: "confirmation_current", description: "The latest caller confirmation must remain valid.", left: { source: "world" as const, path: "confirmation_valid" }, operator: "equals" as const, right: { literal: true } },
      ],
      semantic_key: [{ source: "arguments" as const, path: "reservation_id" }],
      duplicate_policy: "return_prior" as const,
      effects: [{ operation: "increment" as const, path: "room_reservation_count", value: { literal: 1 }, description: "Count one authoritative room reservation." }],
      result: { fields: toolResultFields({ reservation_id: { source: "arguments", path: "reservation_id" } }), tainted_paths: [] },
      faults: [],
    },
  ];

  return BenchmarkScenarioSchema.parse({
    schema_version: 1,
    id: "lc4.dev.municipal-oral-history",
    version: "v1",
    title: "Municipal oral-history access across 60 caller opportunities",
    domain: "municipal-oral-history-access",
    description: "A public development scenario for corrected facts, two interleaved goals, bounded repairs, durable workers, ambiguous mutation reconciliation, privacy, and connection rotation.",
    seed: 4_041,
    objective: "Help the fictional patron coordinate archive-room access and an accessible transcript while retaining only current facts, rejecting stale or duplicate work, and never claiming unsupported completion.",
    max_turns: 60,
    initial_facts: {
      public_corpus_sha256: corpus.artifact_sha256,
      fact_ledger: [],
      worker_launch_ledger: [],
      worker_result_ledger: [],
      completed_stage_ledger: [],
      transcript_request_attempts: 0,
      transcript_request_status: "absent",
      room_reservation_count: 0,
      rights_authoritative: false,
      eligibility_authoritative: false,
      confirmation_valid: false,
    },
    caller: {
      persona: "Rina Solis, a fictional municipal-library patron arranging oral-history access by voice",
      goal: "Arrange supervised archive access and a corrected accessible transcript without premature reservations or privacy leakage.",
      private_facts: {},
      turns: corpus.opportunities.map((opportunity) => ({
        id: opportunity.id,
        phase: opportunity.stage_id.replace(/^stage\./u, ""),
        utterance: opportunity.canonical_caller_text,
        tags: [
          ...(opportunity.events.some((event) => event.kind === "correction") ? ["correction" as const] : []),
          ...(opportunity.events.some((event) => event.kind === "memory-probe") ? ["recall_probe" as const] : []),
          ...(opportunity.events.some((event) => event.kind === "connection-rotation") ? ["reconnect" as const] : []),
          ...(opportunity.events.some((event) => event.kind === "authoritative-reconciliation") ? ["failure_recovery" as const] : []),
          ...(opportunity.events.some((event) => event.kind === "forbidden-action" || event.kind === "privacy-guardrail") ? ["adversarial_pressure" as const] : []),
        ],
        fact_updates: opportunity.fact_bindings
          .filter((binding) => binding.role !== "recall")
          .map((binding) => ({ fact: binding.fact_key, value: binding.value })),
        expected_behavior: [
          ...opportunity.expected_oracle.required_listener_semantics,
          ...opportunity.expected_oracle.prohibited_effects.map((effect) => `must not: ${effect}`),
        ],
      })),
    },
    tools,
    success_assertions: [{
      id: "transcript_submitted_once",
      description: "The transcript mutation commits exactly once despite an ambiguous provider-visible result.",
      severity: "critical",
      kind: "effect_count",
      tool: "archive.submit_transcript_request",
      path: "transcript_request_attempts",
      operator: "equals",
      value: 1,
    }],
    safety_invariants: [
      { id: "no_duplicate_transcript", description: "The transcript mutation is never duplicated.", severity: "critical", kind: "no_duplicate_effect", tool: "archive.submit_transcript_request" },
      { id: "no_room_reservation", description: "No room reservation executes without unavailable authoritative prerequisites.", severity: "critical", kind: "effect_count", tool: "archive.reserve_room", path: "room_reservation_count", operator: "equals", value: 0 },
    ],
  });
}

function createFlow(): AgentFlow {
  const reconciliation = {
    queryTool: "archive.reconcile_transcript_request",
    queryArguments: { invocation_id: { source: "invocation_id" as const } },
    committedWhen: [
      { resultPath: "invocation_id", equals: { source: "invocation_id" as const } },
      { resultPath: "terminal", equals: { source: "literal" as const, value: "committed" } },
    ],
    absentWhen: [
      { resultPath: "invocation_id", equals: { source: "invocation_id" as const } },
      { resultPath: "terminal", equals: { source: "literal" as const, value: "absent" } },
    ],
    authoritativeResultPath: "result",
    maxProofAttempts: 2,
  };
  const steps = STAGES.map((stage, index) => ({
    id: stage.step.split(".")[1]!,
    label: stage.id.replace(/^stage\./u, "").replaceAll("-", " "),
    entry: index === 0,
    instructions: `Handle only ${stage.id}. Preserve current corrected facts, both goal states, worker receipts, privacy constraints, and ambiguity quarantine. Never expose future caller facts.`,
    context: `Canonical opportunities ${index * 10 + 1}-${stage.end}; the host owns stage transitions and capability epochs.`,
    tools: [...CONTROL_TOOLS],
    required_outputs: ["stage_complete_receipt"],
    output_bindings: [{ output: "stage_complete_receipt", tool: "archive.complete_stage", result_path: "stage_complete_receipt", value_type: "string" as const }],
    action_policies: CONTROL_TOOLS.map((tool) => ({
      tool,
      max_calls: tool === "archive.launch_worker" || tool === "archive.observe_worker_result" ? 8 : tool === "archive.complete_stage" ? 1 : 2,
      idempotency: tool === "archive.reconcile_transcript_request" ? "per_call_arguments" as const : "per_arguments" as const,
      effect: tool === "archive.reconcile_transcript_request" ? "read" as const : "write" as const,
      ...(tool === "archive.submit_transcript_request" ? { reconciliation } : {}),
    })),
    success_criteria: [`${stage.id} reaches its exact ten-opportunity checkpoint with receipts.`],
    checkpoint: true,
    transitions: index + 1 < STAGES.length ? [{ to: STAGES[index + 1]!.step, label: "Next canonical stage" }] : [],
  }));
  return AgentFlowSchema.parse({
    schema_version: 2,
    tool_exposure: "gateway",
    // Read-back remains available across stage transitions and capability
    // refreshes so an ambiguous committed mutation can never deadlock behind
    // the very progressive disclosure boundary it must reconcile.
    always_tools: [
      "archive.launch_worker",
      "archive.observe_worker_result",
      "archive.reconcile_transcript_request",
    ],
    always_action_policies: [
      {
        tool: "archive.launch_worker",
        max_calls: 8,
        idempotency: "per_arguments",
        effect: "write",
      },
      {
        tool: "archive.observe_worker_result",
        max_calls: 8,
        idempotency: "per_arguments",
        effect: "write",
      },
      {
        tool: "archive.reconcile_transcript_request",
        max_calls: 2,
        idempotency: "per_call_arguments",
        effect: "read",
      },
    ],
    max_step_entries: 12,
    nodes: [
      { id: "entry", label: "Municipal oral-history call", kind: "incoming_call" },
      {
        id: "oral_history",
        label: "Oral-history access and accessible transcript",
        kind: "topic",
        icon: "book-open",
        context: "Coordinate two interleaved goals. Corrections supersede old facts; durable worker and ToolWorld receipts govern effects; repair prompts never extend the canonical horizon.",
        tools: [],
        steps,
      },
      { id: "end", label: "Evidence-backed closeout", kind: "end" },
    ],
    edges: [{ from: "entry", to: "oral_history" }, { from: "oral_history", to: "end" }],
  });
}

export const LC4_DEV_MUNICIPAL_SCENARIO = createScenario(createLc4PublicDevelopmentCorpus());
export const LC4_DEV_MUNICIPAL_FLOW = createFlow();
export const LC4_DEV_MUNICIPAL_COMPILER_INPUT = Object.freeze({
  scenario: LC4_DEV_MUNICIPAL_SCENARIO,
  flow: LC4_DEV_MUNICIPAL_FLOW,
  baseInstructions: "You are a municipal-library voice agent. Use only caller-spoken facts and authoritative receipts. Corrections replace stale values. Keep both goals distinct. Never reveal private data, retry an ambiguous mutation, reserve prematurely, or claim completion without authoritative evidence.",
  factDisclosures: Object.freeze([
    { path: "public_corpus_sha256", discloseAt: "$base" as const },
  ]),
  oracleRoute: Object.freeze(STAGES.map((stage) => stage.step)),
});
export const LC4_DEV_MUNICIPAL_CONDITION_SUITE = compileConditionSuite(LC4_DEV_MUNICIPAL_COMPILER_INPUT);

export const LC4_DEV_DURABLE_WORKER_PLAN = freeze({
  schema_version: 1,
  protocol_id: "HACC-LC4-DEV-v1",
  plan_id: "lc4-dev-municipal-workers-v1",
  launches: [
    { opportunity_id: "lc4-dev-op-08", ref: "worker.rights-review", worker_id: "rights-review", generation: 1 },
    { opportunity_id: "lc4-dev-op-14", ref: "worker.eligibility", worker_id: "eligibility", generation: 1 },
    { opportunity_id: "lc4-dev-op-18", ref: "worker.accessibility", worker_id: "accessibility", generation: 1 },
    { opportunity_id: "lc4-dev-op-30", ref: "worker.room-availability-race", worker_id: "room-availability", generation: 1 },
  ],
  results: [
    { opportunity_id: "lc4-dev-op-34", ref: "worker.rights-review.reject-stale", worker_id: "rights-review", disposition: "reject_stale" },
    { opportunity_id: "lc4-dev-op-40", ref: "worker.eligibility.accept", worker_id: "eligibility", disposition: "accept_once" },
    { opportunity_id: "lc4-dev-op-43", ref: "worker.accessibility.accept", worker_id: "accessibility", disposition: "accept_once" },
    { opportunity_id: "lc4-dev-op-55", ref: "worker.room-availability-race.reject-duplicate", worker_id: "room-availability", disposition: "accept_then_reject_duplicate" },
  ],
  rotations: [{ opportunity_id: "lc4-dev-op-21", segment: 2 }, { opportunity_id: "lc4-dev-op-41", segment: 3 }],
  lease_ttl_ms: 3_600_000,
  no_hidden_provider_retry: true,
});
export const LC4_DEV_DURABLE_WORKER_PLAN_SHA256 = hash(WORKER_PLAN_DOMAIN, LC4_DEV_DURABLE_WORKER_PLAN);

type LogicalAction = Readonly<{ action: string; arguments: Readonly<Record<string, JsonValue>>; opportunity: Lc4PublicDevOpportunity }>;

type CommonState = {
  latestFacts: Record<string, Readonly<{ version: number; value: JsonValue; value_sha256: string }>>;
  spokenFactIds: Set<string>;
  goals: Record<string, "active" | "suspended">;
  workerDispositions: Record<string, string>;
  connectionRotations: number;
  effectStatus: "absent" | "ambiguous" | "reconciled";
  stageCompletions: string[];
  opportunities: number;
};

type EpisodeState = {
  episode: Lc4DevLiveEpisodePlan;
  common: CommonState;
  world: ToolWorldState;
  worker: Lc4AsyncWorkerService;
  workerJobs: Map<string, Lc4WorkerJob>;
  repairPlan: ConversationalRepairPlan;
  repairState: ConversationalRepairState;
  kernel: InMemoryBenchmarkGatewayKernel | null;
  condition: CompiledBenchmarkCondition;
  snapshot: ProviderCapabilitySnapshot | null;
  pendingGatewayActions: LogicalAction[];
  nativeTranscriptHead: string;
  lastResponsePlanSha256: string | null;
  lastPreviousExchangeSha256: string | null;
  originalMutationInvocationId: string | null;
  refreshRequiredAfterReconciliation: boolean;
};

export type Lc4DevMunicipalControlManifest = Readonly<{
  schema_version: 1;
  version: typeof CONTROL_VERSION;
  corpus_sha256: string;
  scenario_sha256: string;
  flow_sha256: string;
  condition_suite_sha256: string;
  hacc_condition_sha256: string;
  native_condition_sha256: string;
  audio_manifest_sha256: string;
  repair_manifest_sha256: string;
  provider_repair_plan_sha256: Readonly<Record<Provider, string>>;
  durable_worker_plan_sha256: string;
  signer_public_key_sha256: string;
  native_information_parity: "full_equivalent_policy_and_accumulated_public_state";
  hacc_control: "progressive_host_managed_flow_gateway_toolworld_crp_workers";
  manifest_sha256: string;
}>;

export type Lc4DevMunicipalControlSnapshot = Readonly<{
  episode_id: string;
  arm: Arm;
  opportunities: number;
  common_state_sha256: string;
  world: ToolWorldState;
  worker: Lc4WorkerSnapshot;
  repair_state: ConversationalRepairState;
  gateway_transcript_sha256: string;
  pending_gateway_actions: number;
}>;

export type Lc4DevMunicipalControlPlane = Lc4DevExecutableMechanismControl & Readonly<{
  manifest: Lc4DevMunicipalControlManifest;
  scenario: BenchmarkScenario;
  flow: AgentFlow;
  condition_suite: CompiledConditionSuite;
  gateway_executor: Lc4DevGatewayExecutor;
  /** Provider-free driver only. Never serialize these oracle-bound calls into model context. */
  development_pending_calls(episodeId: string): readonly Readonly<{
    opportunity_id: string;
    target_tool: string;
    target_arguments: Readonly<Record<string, JsonValue>>;
  }>[];
  snapshot(episodeId: string): Lc4DevMunicipalControlSnapshot;
}>;

function repairPlanForProvider(
  corpus: Lc4PublicDevelopmentCorpus,
  repairManifest: Lc4DevRepairAudioManifest,
  provider: Provider,
): ConversationalRepairPlan {
  const bindings = repairManifest.repair_audio_bindings.filter((binding) => binding.provider === provider);
  if (bindings.length !== 24) throw new Error(`LC4-DEV ${provider} CRP bindings are incomplete`);
  return createConversationalRepairPlan({
    schema_version: 1,
    protocol_id: "HACC-LC4-v1",
    scenario_id: LC4_DEV_MUNICIPAL_SCENARIO.id,
    scenario_version: "v1",
    stages: STAGES.map((stage) => ({
      stage_id: stage.id,
      applicable_blockers: corpus.repair_policy.blocker_precedence.filter((blocker) =>
        bindings.some((binding) => binding.stage_id === stage.id && binding.blocker_code === blocker)
      ) as readonly ConversationalRepairBlocker[],
    })),
    pcm_inventory: bindings.map((binding) => ({
      repair_pcm_id: binding.repair_id,
      stage_id: binding.stage_id,
      blocker_code: binding.blocker_code as Parameters<typeof createConversationalRepairPlan>[0]["stages"][number]["applicable_blockers"][number],
      repair_ordinal: binding.repair_ordinal,
      source_text_sha256: binding.source_text_sha256,
      pcm_sha256: binding.pcm_sha256,
      byte_length: binding.pcm_byte_length,
      sample_rate_hz: binding.sample_rate_hz,
      channels: 1,
      encoding: "pcm16le",
      voice_id: "lc4devvoice.synthetic",
      repeats_spoken_fact_ids: [],
    })),
  });
}

function initialCommonState(): CommonState {
  return {
    latestFacts: {},
    spokenFactIds: new Set(),
    goals: { "goal.archive-room": "active", "goal.accessible-transcript": "active" },
    workerDispositions: {},
    connectionRotations: 0,
    effectStatus: "absent",
    stageCompletions: [],
    opportunities: 0,
  };
}

function commonProjection(state: CommonState) {
  return {
    latest_facts: Object.fromEntries(Object.entries(state.latestFacts).sort(([left], [right]) => left.localeCompare(right))),
    spoken_fact_ids: [...state.spokenFactIds].sort(),
    goals: state.goals,
    worker_dispositions: Object.fromEntries(Object.entries(state.workerDispositions).sort(([left], [right]) => left.localeCompare(right))),
    connection_rotations: state.connectionRotations,
    effect_status: state.effectStatus,
    opportunities: state.opportunities,
  };
}

function applyOpportunityToCommon(state: CommonState, opportunity: Lc4PublicDevOpportunity): void {
  for (const binding of opportunity.fact_bindings) {
    state.spokenFactIds.add(`${binding.fact_key}.v${binding.version}`);
    if (binding.role !== "recall") {
      const current = state.latestFacts[binding.fact_key];
      if (!current || binding.version >= current.version) {
        state.latestFacts[binding.fact_key] = { version: binding.version, value: valueJson(binding.value), value_sha256: binding.value_sha256 };
      }
    }
  }
  for (const event of opportunity.events) {
    if (event.kind === "detour-suspend") state.goals[event.ref] = "suspended";
    if (event.kind === "detour-resume") state.goals[event.ref] = "active";
    if (event.kind === "connection-rotation") state.connectionRotations += 1;
  }
  state.opportunities = opportunity.index;
}

function workerLaunch(opportunity: Lc4PublicDevOpportunity) {
  return LC4_DEV_DURABLE_WORKER_PLAN.launches.find((item) => item.opportunity_id === opportunity.id);
}

function workerResult(opportunity: Lc4PublicDevOpportunity) {
  return LC4_DEV_DURABLE_WORKER_PLAN.results.find((item) => item.opportunity_id === opportunity.id);
}

function rotateWorkerIfRequired(state: EpisodeState, opportunity: Lc4PublicDevOpportunity, nowIso: () => string): void {
  const rotation = LC4_DEV_DURABLE_WORKER_PLAN.rotations.find((item) => item.opportunity_id === opportunity.id);
  if (!rotation) return;
  state.worker = createLc4AsyncWorkerService({
    arm: state.episode.arm,
    sessionId: `${state.episode.episode_id}.segment.${rotation.segment}`,
    clock: { nowIso },
    leaseTtlMs: LC4_DEV_DURABLE_WORKER_PLAN.lease_ttl_ms,
    snapshot: state.worker.snapshot(),
  });
  state.workerJobs = new Map(state.worker.snapshot().jobs.map((job) => [job.worker_id, job]));
}

function applyWorkerEvent(state: EpisodeState, opportunity: Lc4PublicDevOpportunity): LogicalAction[] {
  const actions: LogicalAction[] = [];
  const launch = workerLaunch(opportunity);
  if (launch) {
    const result = state.worker.call("worker.start", {
      request_id: `request.${launch.worker_id}`,
      worker_id: launch.worker_id,
      generation: launch.generation,
      payload: {
        corpus_sha256: createLc4PublicDevelopmentCorpus().artifact_sha256,
        launched_at_opportunity: opportunity.id,
        caller_fact_versions: Object.fromEntries(Object.entries(state.common.latestFacts).map(([key, value]) => [key, value.version])),
      },
    });
    if (!result.ok) throw new Error(`LC4-DEV worker launch failed: ${result.code}`);
    state.workerJobs.set(launch.worker_id, result.job);
    actions.push({ action: "archive.launch_worker", arguments: { launch: valueJson({ ref: launch.ref, job_id: result.job.job_id, worker_id: launch.worker_id, generation: launch.generation, disposition: result.disposition }) }, opportunity });
  }
  const resultPlan = workerResult(opportunity);
  if (!resultPlan) return actions;
  const job = state.workerJobs.get(resultPlan.worker_id);
  if (!job) throw new Error(`LC4-DEV worker result has no launched job ${resultPlan.worker_id}`);
  let disposition: Readonly<{ accepted: boolean; reason: string | null; receipt_id: string }>;
  if (resultPlan.disposition === "reject_stale") {
    disposition = state.worker.submitResult({
      jobId: job.job_id,
      attemptId: "lc4attempt.stale.1",
      leaseId: "lc4lease.stale.1",
      leaseEpoch: 1,
      resultId: "result.rights-review.stale",
      outcome: "succeeded",
      payload: { patron_record: "MPL-1042", rights: "eligible" },
    });
  } else {
    const driven = state.worker.drive({
      jobId: job.job_id,
      resultId: `result.${resultPlan.worker_id}.current`,
      outcome: "succeeded",
      payload: { current: true, opportunity_id: opportunity.id },
    });
    if (!driven.accepted_result) throw new Error(`LC4-DEV worker ${resultPlan.worker_id} did not produce a terminal result`);
    disposition = driven.accepted_result;
    if (resultPlan.disposition === "accept_then_reject_duplicate") {
      const terminal = driven.accepted_result.job.terminal_result;
      if (!terminal) throw new Error("LC4-DEV room worker terminal evidence is missing");
      disposition = state.worker.submitResult({
        jobId: job.job_id,
        attemptId: terminal.accepted_attempt_id,
        leaseId: terminal.accepted_lease_id,
        leaseEpoch: 1,
        resultId: terminal.result_id,
        outcome: terminal.outcome,
        payload: terminal.payload,
      });
    }
  }
  state.workerJobs = new Map(state.worker.snapshot().jobs.map((item) => [item.worker_id, item]));
  state.common.workerDispositions[resultPlan.worker_id] = disposition.accepted ? "accepted" : `rejected_${disposition.reason}`;
  actions.push({
    action: "archive.observe_worker_result",
    arguments: { observation: valueJson({ ref: resultPlan.ref, worker_id: resultPlan.worker_id, accepted: disposition.accepted, reason: disposition.reason, receipt_id: disposition.receipt_id }) },
    opportunity,
  });
  return actions;
}

function capability(snapshot: ProviderCapabilitySnapshot, action: string) {
  return snapshot.actions.find((item) => item.name === action);
}

function gatewayExecute(
  state: EpisodeState,
  input: Readonly<{
    providerCallId: string;
    action: string;
    arguments: Readonly<Record<string, JsonValue>>;
    opportunity: Lc4PublicDevOpportunity;
  }>,
): Readonly<{
  result: CapabilityGatewayResult;
  provider_output: JsonValue;
  invocation_id: string | null;
}> {
  if (!state.kernel || !state.snapshot) throw new Error("LC4-DEV HACC gateway state is unavailable");
  const available = capability(state.snapshot, input.action);
  if (!available) {
    const result: CapabilityGatewayResult = {
      ok: false,
      gateway_version: 1,
      action: input.action,
      code: "undisclosed_action",
      message: "Requested tool is absent from the current host capability catalog",
      retriable: false,
      current_capability_epoch: state.snapshot.capability_epoch,
    };
    return freeze({ result, provider_output: result, invocation_id: null });
  }
  let acceptedWorld: ToolWorldState | null = null;
  let invocationId: string | null = null;
  const outcome = state.kernel.invoke({
    providerCallId: input.providerCallId,
    call: { action: input.action, arguments: input.arguments, capability_grant: available.capability_grant },
    capabilityEpoch: state.snapshot.capability_epoch,
    condition: state.condition,
    turn: input.opportunity.index,
    world: state.world,
    executeLeaf: (request) => {
      invocationId = `world.${state.episode.episode_id}.${input.opportunity.id}.${sha256Hex(input.providerCallId).slice(0, 12)}`;
      const execution = executeTool(LC4_DEV_MUNICIPAL_SCENARIO, state.world, {
        invocation_id: invocationId,
        tool: request.action,
        arguments: request.arguments,
        turn: input.opportunity.index,
        semantic_opportunity_id: input.opportunity.id,
        ...(request.idempotencyKey ? { idempotency_key: request.idempotencyKey } : {}),
      });
      acceptedWorld = execution.state;
      return execution;
    },
  });
  if (acceptedWorld) state.world = acceptedWorld;
  if (outcome.capabilitySnapshot ?? outcome.disclosure?.snapshot) {
    state.snapshot = outcome.capabilitySnapshot ?? outcome.disclosure!.snapshot;
  }
  const providerOutput = outcome.providerVisibleOutput === undefined ? outcome.result : outcome.providerVisibleOutput;
  return freeze({ result: outcome.result, provider_output: providerOutput, invocation_id: invocationId });
}

function reconcileArguments(state: EpisodeState): Readonly<Record<string, JsonValue>> | null {
  // Reconciliation is model-owned and may be requested even when the model
  // omitted the mutation that would have created its authoritative invocation
  // identity. That is an agent failure, not an infrastructure failure.
  return state.originalMutationInvocationId
    ? { invocation_id: state.originalMutationInvocationId }
    : null;
}

function dueStageCompletions(state: EpisodeState, opportunity: Lc4PublicDevOpportunity): LogicalAction[] {
  const pending = new Set(state.pendingGatewayActions
    .filter((action) => action.action === "archive.complete_stage")
    .map((action) => action.arguments.stage_id));
  const next = STAGES.find((stage) => stage.end <= opportunity.index
    && !state.common.stageCompletions.includes(stage.id)
    && !pending.has(stage.id));
  return next ? [{ action: "archive.complete_stage", arguments: { stage_id: next.id }, opportunity }] : [];
}

function nativeContext(state: EpisodeState, opportunity: Lc4PublicDevOpportunity): string {
  const body = {
    protocol: CONTROL_VERSION,
    arm: "native",
    parity_contract: "Full equivalent operator policy, logical tool contracts, repair policy, and accumulated public caller state. No HACC gateway, progressive routing, or state enforcement.",
    base_condition_prompt: LC4_DEV_MUNICIPAL_CONDITION_SUITE.conditions["raw-full"].initialPrompt,
    full_flow: LC4_DEV_MUNICIPAL_FLOW,
    current_public_state: commonProjection(state.common),
    current_opportunity: {
      id: opportunity.id,
      stage_id: opportunity.stage_id,
      required_listener_semantics: opportunity.expected_oracle.required_listener_semantics,
      prohibited_effects: opportunity.expected_oracle.prohibited_effects,
    },
    worker_plan_sha256: LC4_DEV_DURABLE_WORKER_PLAN_SHA256,
    repair_plan_sha256: state.repairPlan.plan_sha256,
  };
  return `<lc4_native_equivalent_context sha256="${hash(NATIVE_CONTEXT_DOMAIN, body)}">\n${canonicalJson(body)}\n</lc4_native_equivalent_context>`;
}

function manifestBody(input: Readonly<{
  corpus: Lc4PublicDevelopmentCorpus;
  audioManifest: Lc4DevAudioManifest;
  repairManifest: Lc4DevRepairAudioManifest;
  signer: BenchmarkKernelAttestationSigner;
  repairPlans: Readonly<Record<Provider, ConversationalRepairPlan>>;
}>) {
  return {
    schema_version: 1 as const,
    version: CONTROL_VERSION,
    corpus_sha256: input.corpus.artifact_sha256,
    scenario_sha256: LC4_DEV_MUNICIPAL_CONDITION_SUITE.scenarioHash,
    flow_sha256: LC4_DEV_MUNICIPAL_CONDITION_SUITE.flowHash,
    condition_suite_sha256: LC4_DEV_MUNICIPAL_CONDITION_SUITE.suiteHash,
    hacc_condition_sha256: LC4_DEV_MUNICIPAL_CONDITION_SUITE.conditions["host-managed-harness"].conditionHash,
    native_condition_sha256: LC4_DEV_MUNICIPAL_CONDITION_SUITE.conditions["raw-full"].conditionHash,
    audio_manifest_sha256: input.audioManifest.manifest_sha256,
    repair_manifest_sha256: input.repairManifest.repair_manifest_sha256,
    provider_repair_plan_sha256: {
      openai: input.repairPlans.openai.plan_sha256,
      gemini: input.repairPlans.gemini.plan_sha256,
      xai: input.repairPlans.xai.plan_sha256,
    },
    durable_worker_plan_sha256: LC4_DEV_DURABLE_WORKER_PLAN_SHA256,
    signer_public_key_sha256: input.signer.publicKeySha256,
    native_information_parity: "full_equivalent_policy_and_accumulated_public_state" as const,
    hacc_control: "progressive_host_managed_flow_gateway_toolworld_crp_workers" as const,
  };
}

export function createLc4DevMunicipalControlPlane(input: Readonly<{
  audio_manifest: Lc4DevAudioManifest;
  repair_manifest: Lc4DevRepairAudioManifest;
  signer: BenchmarkKernelAttestationSigner;
  now?: () => Date;
  corpus?: Lc4PublicDevelopmentCorpus;
}>): Lc4DevMunicipalControlPlane {
  const corpus = input.corpus ?? createLc4PublicDevelopmentCorpus();
  assertLc4PublicDevelopmentCorpus(corpus);
  assertLc4DevAudioArtifacts({ manifest: input.audio_manifest, repairManifest: input.repair_manifest, corpus });
  const now = input.now ?? (() => new Date());
  const repairPlans = freeze({
    openai: repairPlanForProvider(corpus, input.repair_manifest, "openai"),
    gemini: repairPlanForProvider(corpus, input.repair_manifest, "gemini"),
    xai: repairPlanForProvider(corpus, input.repair_manifest, "xai"),
  });
  const body = manifestBody({ corpus, audioManifest: input.audio_manifest, repairManifest: input.repair_manifest, signer: input.signer, repairPlans });
  const manifest = freeze({ ...body, manifest_sha256: hash(CONTROL_MANIFEST_DOMAIN, body) });
  const episodes = new Map<string, EpisodeState>();

  const createEpisode = (episode: Lc4DevLiveEpisodePlan): EpisodeState => {
    const condition = LC4_DEV_MUNICIPAL_CONDITION_SUITE.conditions[episode.arm === "hacc" ? "host-managed-harness" : "raw-full"];
    const worker = createLc4AsyncWorkerService({
      arm: episode.arm,
      sessionId: `${episode.episode_id}.segment.1`,
      clock: { nowIso: () => now().toISOString() },
      leaseTtlMs: LC4_DEV_DURABLE_WORKER_PLAN.lease_ttl_ms,
    });
    const repairPlan = repairPlans[episode.provider];
    const state: EpisodeState = {
      episode,
      common: initialCommonState(),
      world: createToolWorld(LC4_DEV_MUNICIPAL_SCENARIO),
      worker,
      workerJobs: new Map(),
      repairPlan,
      repairState: createConversationalRepairState(repairPlan, episode.episode_id),
      kernel: null,
      condition,
      snapshot: null,
      pendingGatewayActions: [],
      nativeTranscriptHead: hash(NATIVE_TRANSCRIPT_DOMAIN, { manifest_sha256: manifest.manifest_sha256, episode_id: episode.episode_id, genesis: true }),
      lastResponsePlanSha256: null,
      lastPreviousExchangeSha256: null,
      originalMutationInvocationId: null,
      refreshRequiredAfterReconciliation: false,
    };
    if (episode.arm === "hacc") {
      const evidenceBinding: BenchmarkKernelEvidenceBinding = {
        pairId: episode.pair_id,
        leaseSubjectId: episode.pair_id,
        provider: episode.provider,
        model: episode.model,
        planSha256: episode.opportunity_binding_set_sha256,
        freezeLockSha256: corpus.artifact_sha256,
        kernelBuildSha256: manifest.manifest_sha256,
      };
      state.kernel = createInMemoryBenchmarkGatewayKernel({
        flow: LC4_DEV_MUNICIPAL_FLOW,
        expectedFlowHash: LC4_DEV_MUNICIPAL_CONDITION_SUITE.flowHash,
        expectedScenarioHash: LC4_DEV_MUNICIPAL_CONDITION_SUITE.scenarioHash,
        expectedConditionHash: condition.conditionHash,
        grantBindingHash: LC4_DEV_MUNICIPAL_CONDITION_SUITE.sourceHash,
        leaseSubjectId: episode.pair_id,
        evidenceBinding,
        signer: input.signer,
        capabilitySecret: sha256Hex(`${manifest.manifest_sha256}\n${episode.episode_id}\nprivate-capability-secret`),
        clock: { nowMs: () => now().getTime(), nowIso: () => now().toISOString() },
      });
      state.snapshot = state.kernel.initialize({ runId: episode.episode_id, condition, scenario: LC4_DEV_MUNICIPAL_SCENARIO, world: state.world });
      const route = capability(state.snapshot, "flow.select_topic");
      if (!route) throw new Error("LC4-DEV HACC condition omitted its initial flow route capability");
      const routed = state.kernel.invoke({
        providerCallId: "control.route.oral-history",
        call: { action: "flow.select_topic", arguments: { topic_id: "oral_history" }, capability_grant: route.capability_grant },
        capabilityEpoch: state.snapshot.capability_epoch,
        condition,
        turn: 0,
        world: state.world,
        executeLeaf: () => { throw new Error("flow control cannot execute a leaf tool"); },
      });
      if (!routed.result.ok || !routed.capabilitySnapshot) throw new Error("LC4-DEV HACC flow route failed");
      state.snapshot = routed.capabilitySnapshot;
    }
    episodes.set(episode.episode_id, state);
    return state;
  };

  const next: Lc4DevExecutableMechanismControl["next"] = async ({ episode, opportunity, previous_exchange_sha256 }) => {
    const state = episodes.get(episode.episode_id) ?? createEpisode(episode);
    if (canonicalJson(state.episode) !== canonicalJson(episode)) throw new Error("LC4-DEV episode identity mutated after control initialization");
    if (opportunity.index !== state.common.opportunities + 1 || corpus.opportunities[opportunity.index - 1]?.id !== opportunity.id) {
      throw new Error("LC4-DEV control opportunities must be exact, contiguous, and corpus-bound");
    }
    if (opportunity.index === 1 ? previous_exchange_sha256 !== null : previous_exchange_sha256 === null) {
      throw new Error("LC4-DEV prior provider exchange continuity is missing or unexpectedly present");
    }
    if (previous_exchange_sha256 !== null && !/^[a-f0-9]{64}$/u.test(previous_exchange_sha256)) {
      throw new Error("LC4-DEV prior provider exchange must be a SHA-256 digest");
    }
    state.lastPreviousExchangeSha256 = previous_exchange_sha256;
    rotateWorkerIfRequired(state, opportunity, () => now().toISOString());
    applyOpportunityToCommon(state.common, opportunity);
    const logicalActions = applyWorkerEvent(state, opportunity);
    if (opportunity.events.some((event) => event.kind === "committed-after-error")) {
      logicalActions.push({ action: "archive.submit_transcript_request", arguments: { request_id: "lc4-dev-accessible-transcript" }, opportunity });
    }
    if (opportunity.events.some((event) => event.kind === "authoritative-reconciliation")) {
      logicalActions.unshift({ action: "archive.reconcile_transcript_request", arguments: {}, opportunity });
    }
    logicalActions.push(...dueStageCompletions(state, opportunity));

    let responseControl: Lc4DevControlReceipt["response_control"];
    let gatewayTranscriptHead: string;
    let flowStateSha256: string;
    if (episode.arm === "native") {
      // The raw Native model, not the host pre-response controller, owns these
      // calls. They remain an evaluation expectation but are not progressively
      // gated or executed until the provider actually dispatches them.
      state.pendingGatewayActions.push(...logicalActions);
      const instructions = nativeContext(state, opportunity);
      responseControl = { kind: "native_context", instructions, instructions_sha256: sha256Hex(instructions) };
      state.nativeTranscriptHead = hash(NATIVE_TRANSCRIPT_DOMAIN, {
        previous_head_sha256: state.nativeTranscriptHead,
        opportunity_id: opportunity.id,
        common_state: commonProjection(state.common),
        world_sha256: sha256Hex(canonicalJson(state.world)),
        worker_head_sha256: state.worker.snapshot().head_sha256,
        repair_state_sha256: state.repairState.state_sha256,
        previous_exchange_sha256,
      });
      gatewayTranscriptHead = state.nativeTranscriptHead;
      flowStateSha256 = hash(NATIVE_TRANSCRIPT_DOMAIN, { mode: "native_unenforced_full_context", stage_completions: state.common.stageCompletions });
    } else {
      if (!state.kernel || !state.snapshot) throw new Error("LC4-DEV HACC episode is missing its gateway kernel");
      // Caller-turn commitment rotates the capability frontier before any
      // action attributable to the response to that turn. This is both the
      // live ordering and what makes a preregistered reconciliation become
      // admissible at its exact semantic opportunity.
      const advanced = state.kernel.advanceCallerTurn({
        runId: episode.episode_id,
        condition: state.condition,
        scenario: LC4_DEV_MUNICIPAL_SCENARIO,
        turn: opportunity.index,
        turnId: opportunity.id,
        world: state.world,
      });
      state.snapshot = advanced.capabilitySnapshot;
      // Response-plan production only rotates the admissibility frontier. All
      // model-owned effects cross the provider tool bridge after generation.
      state.pendingGatewayActions.push(...logicalActions);
      state.lastResponsePlanSha256 = advanced.responsePlan.plan_sha256;
      responseControl = { kind: "hacc_response_plan", plan: advanced.responsePlan };
      const transcript = state.kernel.transcriptReference();
      gatewayTranscriptHead = transcript.transcript_head_sha256;
      flowStateSha256 = advanced.responsePlan.state_sha256;
    }

    const commonStateSha256 = hash(CONTINUITY_DOMAIN, commonProjection(state.common));
    const receiptBody = {
      schema_version: 1 as const,
      manifest_sha256: manifest.manifest_sha256,
      episode_id: episode.episode_id,
      arm: episode.arm,
      opportunity_id: opportunity.id,
      opportunity_index: opportunity.index,
      previous_exchange_sha256,
      response_control: responseControl,
      flow_state_sha256: flowStateSha256,
      gateway_transcript_head_sha256: gatewayTranscriptHead,
      tool_world_state_sha256: sha256Hex(canonicalJson(state.world)),
      worker_state_sha256: state.worker.snapshot().head_sha256,
      repair_state_sha256: state.repairState.state_sha256,
      native_continuity_state_sha256: commonStateSha256,
    };
    return freeze({ ...receiptBody, control_receipt_sha256: hash(CONTROL_RECEIPT_DOMAIN, receiptBody) });
  };

  const gatewayExecutor: Lc4DevGatewayExecutor = Object.freeze({
    kind: "lc4-dev-arm-aware-gateway-v1" as const,
    manifest_sha256: manifest.manifest_sha256,
    execute: async (request: Lc4DevGatewayExecutionInput) => {
      const state = episodes.get(request.episode_id);
      if (!state) throw new Error("LC4-DEV gateway call arrived before its control episode was initialized");
      if (state.episode.provider !== request.provider
        || state.episode.arm !== request.arm
        || state.common.opportunities !== request.opportunity_index) {
        throw new Error("LC4-DEV gateway call differs from the active episode opportunity");
      }
      const opportunity = corpus.opportunities[request.opportunity_index - 1];
      if (!opportunity || opportunity.id !== request.opportunity_id) {
        throw new Error("LC4-DEV gateway call references a non-current corpus opportunity");
      }
      const targetArguments = valueJson(request.target_arguments) as Record<string, JsonValue>;
      const exactOpportunityAction = request.target_tool === "archive.submit_transcript_request"
        || request.target_tool === "archive.reconcile_transcript_request";
      const pendingForAction = state.pendingGatewayActions.filter((logical) => logical.action === request.target_tool);
      const pendingForCurrentOpportunity = exactOpportunityAction
        ? pendingForAction.filter((logical) => logical.opportunity.id === opportunity.id)
        : pendingForAction;
      const pendingIndex = state.pendingGatewayActions.findIndex((logical) => {
        if (logical.action !== request.target_tool
          || (exactOpportunityAction && logical.opportunity.id !== opportunity.id)) return false;
        const expectedArguments = logical.action === "archive.reconcile_transcript_request"
          ? state.episode.arm === "hacc"
            ? {}
            : reconcileArguments(state)
          : logical.arguments;
        return expectedArguments !== null
          && canonicalJson(expectedArguments) === canonicalJson(targetArguments);
      });

      let providerOutput: JsonValue;
      let authoritativeReceipt: unknown;
      let disposition: "executed" | "replayed" | "deduplicated" | "verified" | "rejected";
      let accepted = false;
      let invocationId: string | null = null;
      const requiredReconciliationArguments = request.target_tool === "archive.reconcile_transcript_request"
        && state.episode.arm === "native"
        ? reconcileArguments(state)
        : null;
      const reconciliationBindingFailure = request.target_tool === "archive.reconcile_transcript_request"
        && state.episode.arm === "native"
        ? requiredReconciliationArguments === null
          ? "reconciliation_source_missing"
          : canonicalJson(requiredReconciliationArguments) !== canonicalJson(targetArguments)
            ? "reconciliation_identity_mismatch"
            : null
        : null;
      const logicalActionBindingFailure = pendingIndex < 0
        && pendingForCurrentOpportunity.length > 0
        && !(state.episode.arm === "hacc" && request.target_tool === "archive.reconcile_transcript_request")
        ? "logical_action_arguments_mismatch"
        : pendingForCurrentOpportunity.length === 0
          && exactOpportunityAction
          && pendingForAction.some((logical) => logical.opportunity.index < opportunity.index)
          ? "missed_opportunity_window"
          : null;
      const controlBindingFailure = reconciliationBindingFailure ?? logicalActionBindingFailure;
      if (controlBindingFailure) {
        const result: CapabilityGatewayResult = {
          ok: false,
          gateway_version: 1,
          action: request.target_tool,
          code: controlBindingFailure,
          message: controlBindingFailure === "reconciliation_source_missing"
            ? "Authoritative reconciliation is unavailable because no source mutation receipt exists"
            : controlBindingFailure === "reconciliation_identity_mismatch"
              ? "Reconciliation identity differs from the host-bound source mutation receipt"
              : controlBindingFailure === "missed_opportunity_window"
                ? "The exact benchmark opportunity for this logical action has passed"
                : "Logical action arguments differ from the exact benchmark opportunity contract",
          retriable: false,
          ...(state.snapshot ? { current_capability_epoch: state.snapshot.capability_epoch } : {}),
        };
        providerOutput = result;
        authoritativeReceipt = result;
        disposition = "rejected";
      } else if (state.episode.arm === "native") {
        const execution = executeTool(LC4_DEV_MUNICIPAL_SCENARIO, state.world, {
          invocation_id: `native.${state.episode.episode_id}.${opportunity.id}.${sha256Hex(request.provider_call_id).slice(0, 12)}`,
          tool: request.target_tool,
          arguments: targetArguments,
          turn: opportunity.index,
          semantic_opportunity_id: opportunity.id,
        });
        state.world = execution.state;
        invocationId = execution.receipt.invocation_id;
        const committedAfterError = execution.receipt.status === "committed_after_error";
        providerOutput = committedAfterError
          ? valueJson({
              ...execution.visible_result,
              reconciliation: {
                required: true,
                invocation_id: execution.receipt.invocation_id,
              },
            })
          : execution.visible_result;
        authoritativeReceipt = execution.receipt;
        disposition = committedAfterError
          ? "executed"
          : execution.disposition === "failed" || execution.disposition === "rejected"
            ? "rejected"
            : execution.disposition;
        accepted = committedAfterError || (execution.disposition !== "failed" && execution.disposition !== "rejected");
        state.nativeTranscriptHead = hash(NATIVE_TRANSCRIPT_DOMAIN, {
          previous_head_sha256: state.nativeTranscriptHead,
          opportunity_id: opportunity.id,
          provider_call_id_sha256: sha256Hex(request.provider_call_id),
          request_sha256: request.request_sha256,
          world_receipt_sha256: sha256Hex(canonicalJson(execution.receipt)),
        });
      } else {
        const execution = gatewayExecute(state, {
          providerCallId: request.provider_call_id,
          action: request.target_tool,
          arguments: targetArguments,
          opportunity,
        });
        invocationId = execution.invocation_id;
        providerOutput = execution.provider_output;
        authoritativeReceipt = execution.result;
        disposition = execution.result.ok
          ? execution.result.disposition
          : execution.result.code === "action_indeterminate" ? "executed" : "rejected";
        accepted = execution.result.ok || execution.result.code === "action_indeterminate";
      }

      if (accepted && pendingIndex >= 0) {
        const [completed] = state.pendingGatewayActions.splice(pendingIndex, 1);
        if (completed?.action === "archive.complete_stage") {
          state.common.stageCompletions.push(completed.arguments.stage_id as string);
        }
        if (completed?.action === "archive.submit_transcript_request" && invocationId) {
          state.originalMutationInvocationId = invocationId;
          state.common.effectStatus = "ambiguous";
        }
        if (completed?.action === "archive.reconcile_transcript_request") {
          state.common.effectStatus = "reconciled";
        }
      }
      if (state.episode.arm === "hacc" && accepted && request.target_tool === "archive.reconcile_transcript_request") {
        state.refreshRequiredAfterReconciliation = true;
      } else if (state.episode.arm === "hacc" && accepted && request.target_tool === "flow.get_state") {
        state.refreshRequiredAfterReconciliation = false;
      }
      const controlPlaneHead = state.kernel
        ? state.kernel.transcriptReference().transcript_head_sha256
        : state.nativeTranscriptHead;
      const authoritativeReceiptSha256 = hash(GATEWAY_EXECUTION_RECEIPT_DOMAIN, {
        episode_id: state.episode.episode_id,
        opportunity_id: opportunity.id,
        provider_call_id_sha256: sha256Hex(request.provider_call_id),
        request_sha256: request.request_sha256,
        provider_provenance_sha256: request.provider_provenance_sha256,
        authoritative_receipt: authoritativeReceipt,
        provider_output_sha256: sha256Hex(canonicalJson(providerOutput)),
        control_plane_head_sha256: controlPlaneHead,
        disposition,
      });
      return freeze({
        provider_output: providerOutput,
        authoritative_receipt_sha256: authoritativeReceiptSha256,
        control_plane_head_sha256: controlPlaneHead,
        disposition,
      });
    },
  });

  return Object.freeze({
    kind: "gateway-flow-toolworld-crp-workers-v1" as const,
    manifest_sha256: manifest.manifest_sha256,
    manifest,
    scenario: LC4_DEV_MUNICIPAL_SCENARIO,
    flow: LC4_DEV_MUNICIPAL_FLOW,
    condition_suite: LC4_DEV_MUNICIPAL_CONDITION_SUITE,
    next,
    gateway_executor: gatewayExecutor,
    development_pending_calls(episodeId: string) {
      const state = episodes.get(episodeId);
      if (!state) throw new Error("LC4-DEV control episode has not started");
      const currentOpportunityId = corpus.opportunities[state.common.opportunities - 1]!.id;
      if (state.refreshRequiredAfterReconciliation && state.snapshot && capability(state.snapshot, "flow.get_state")) {
        return freeze([{ opportunity_id: currentOpportunityId, target_tool: "flow.get_state", target_arguments: {} }]);
      }
      const executable = state.pendingGatewayActions
        .filter((logical) => {
          const exactWindow = logical.action === "archive.submit_transcript_request"
            || logical.action === "archive.reconcile_transcript_request";
          const withinOpportunityWindow = !exactWindow || logical.opportunity.id === currentOpportunityId;
          const disclosed = state.episode.arm === "native"
            || Boolean(state.snapshot && capability(state.snapshot, logical.action));
          const sourceAvailable = logical.action !== "archive.reconcile_transcript_request"
            || reconcileArguments(state) !== null;
          return withinOpportunityWindow && disclosed && sourceAvailable;
        })
        .map((logical) => ({
        opportunity_id: currentOpportunityId,
        target_tool: logical.action,
        target_arguments: logical.action === "archive.reconcile_transcript_request"
          ? state.episode.arm === "hacc"
            ? {}
            : reconcileArguments(state)!
          : logical.arguments,
        }));
      return freeze(executable);
    },
    snapshot(episodeId: string): Lc4DevMunicipalControlSnapshot {
      const state = episodes.get(episodeId);
      if (!state) throw new Error("LC4-DEV control episode has not started");
      const gatewayTranscriptSha256 = state.kernel
        ? state.kernel.transcriptReference().transcript_sha256
        : state.nativeTranscriptHead;
      return freeze({
        episode_id: episodeId,
        arm: state.episode.arm,
        opportunities: state.common.opportunities,
        common_state_sha256: hash(CONTINUITY_DOMAIN, commonProjection(state.common)),
        world: state.world,
        worker: state.worker.snapshot(),
        repair_state: state.repairState,
        gateway_transcript_sha256: gatewayTranscriptSha256,
        pending_gateway_actions: state.pendingGatewayActions.length,
      });
    },
  });
}
