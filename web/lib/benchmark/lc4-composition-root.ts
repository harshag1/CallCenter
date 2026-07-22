import { AgentFlowSchema, validateAgentFlow, type AgentFlow, type FlowStep } from "../flow";
import { canonicalJson, immutableJson, sha256Hex, type JsonValue } from "./artifacts";
import type { ConversationalRepairPlanInput, ConversationalRepairStage } from "./conversational-repair";
import {
  verifyLc4HeldoutCommitment,
  type Lc4GeneratedHeldoutTemplate,
  type Lc4SealedHeldoutBundle,
} from "./lc4-heldout-commitment";
import {
  LC4_LISTENER_SEMANTIC_PROTOCOL_SHA256,
  LC4_NORMATIVE_BLOCKER_CODES,
  LC4_PRIMARY_CONJUNCTS,
  assertLc4GenericScenarioPayload,
  lc4ListenerSemanticScheduleSha256,
  type Lc4GenericScenarioPayload,
} from "./lc4-heldout-generator";
import {
  createLc4FrozenListenerSemanticRegistry,
  createLc4FrozenListenerSemanticRegistryManifest,
  createLc4ListenerSemanticPlan,
  type Lc4FrozenListenerSemanticRegistryManifest,
  type Lc4ListenerSemanticPlan,
} from "./lc4-listener-evidence";
import {
  compileLc4ProductionScheduleShape,
  joinLc4HeldoutTemplatesToSchedule,
  type Lc4EpisodeShape,
  type Lc4HeldoutScheduleJoin,
  type Lc4ProductionScheduleShape,
} from "./lc4-production-runner-foundation";
import { LC4_ASYNC_WORKER_CALLABLE_SURFACE } from "./lc4-async-worker-service";

export const LC4_COMPOSITION_ROOT_VERSION = "HACC-LC4-COMPOSITION-v1" as const;

const SHA256 = /^[a-f0-9]{64}$/u;
const CORPUS_DOMAIN = "harshas-amazing-call-center/lc4-authorized-generated-corpus/v1\n";
const AUTOMATON_DOMAIN = "harshas-amazing-call-center/lc4-caller-automaton/v1\n";
const PARITY_DOMAIN = "harshas-amazing-call-center/lc4-shared-information-parity/v1\n";
const NATIVE_DOMAIN = "harshas-amazing-call-center/lc4-native-context/v1\n";
const HACC_DOMAIN = "harshas-amazing-call-center/lc4-hacc-control-input/v1\n";
const REPAIR_DOMAIN = "harshas-amazing-call-center/lc4-repair-input/v1\n";
const WORKER_DOMAIN = "harshas-amazing-call-center/lc4-worker-plan/v1\n";
const ORACLE_DOMAIN = "harshas-amazing-call-center/lc4-scoring-oracle/v1\n";
const ROOT_DOMAIN = "harshas-amazing-call-center/lc4-composition-root/v1\n";

type PayloadOpportunity = Lc4GenericScenarioPayload["opportunities"][number];
type ParityUnit = Lc4GenericScenarioPayload["arm_information_parity_source"]["canonical_units"][number];

export type Lc4AuthorizedUnsealedGeneratedCorpus = Readonly<{
  schema_version: 1;
  protocol_id: "HACC-LC4-v1";
  authorization: Readonly<{
    scope: "provider_free_composition_only";
    authorization_receipt_sha256: string;
    provider_calls_authorized: false;
    plaintext_logging_authorized: false;
  }>;
  commitment: Readonly<{
    sealed_bundle: Lc4SealedHeldoutBundle;
    independently_published_manifest_sha256: string;
  }>;
  templates: readonly Lc4GeneratedHeldoutTemplate[];
  corpus_sha256: string;
}>;

export type Lc4CanonicalCallerAutomaton = Readonly<{
  schema_version: 1;
  template_id: string;
  initial_state_id: string;
  terminal_state_id: "terminal";
  states: readonly Readonly<{
    ordinal: number;
    state_id: string;
    opportunity_id: string;
    stage_id: string;
    act: PayloadOpportunity["act"];
    goal_id: PayloadOpportunity["goal_id"];
    caller_source_id: string;
    caller_source_text_sha256: string;
    spoken_fact_bindings: PayloadOpportunity["canonical_caller_utterance"]["fact_bindings"];
    registrations: PayloadOpportunity["registrations"];
    next_state_id: string;
  }>[];
  automaton_sha256: string;
}>;

export type Lc4SharedInformationParityArtifact = Readonly<{
  schema_version: 1;
  template_id: string;
  canonical_semantics_sha256: string;
  units: readonly Readonly<{
    id: string;
    kind: ParityUnit["kind"];
    content_sha256: string;
    content: JsonValue;
    native_delivery: "initial_context" | "caller_audio";
    native_available_at_opportunity: number;
    hacc_delivery: "progressive_flow_context" | "caller_audio";
    hacc_available_at_opportunity: number;
  }>[];
  parity_sha256: string;
}>;

export type Lc4NativeContext = Readonly<{
  schema_version: 1;
  template_id: string;
  context_authority: "advisory_only_native_provider_context";
  policy_and_tool_unit_ids: readonly string[];
  caller_fact_schedule: readonly Readonly<{
    opportunity_id: string;
    fact_ids: readonly string[];
  }>[];
  instructions: string;
  instructions_sha256: string;
  native_context_sha256: string;
}>;

export type Lc4HaccControlInput = Readonly<{
  schema_version: 1;
  template_id: string;
  flow: AgentFlow;
  flow_sha256: string;
  response_plan_static_inputs: readonly Readonly<{
    opportunity_id: string;
    stage_id: string;
    target: string;
    catalog_mode: "target";
    expected_logical_tools: readonly string[];
    disclosed_information_unit_ids: readonly string[];
  }>[];
  hacc_control_sha256: string;
}>;

export type Lc4RepairPlanSource = Readonly<{
  schema_version: 1;
  protocol_id: ConversationalRepairPlanInput["protocol_id"];
  scenario_id: string;
  scenario_version: string;
  stages: readonly ConversationalRepairStage[];
  pcm_requirements: readonly Readonly<{
    repair_source_id: string;
    stage_id: string;
    blocker_code: typeof LC4_NORMATIVE_BLOCKER_CODES[number];
    repair_ordinal: 1 | 2;
    source_text_sha256: string;
  }>[];
  repair_input_sha256: string;
}>;

export type Lc4WorkerPlan = Readonly<{
  schema_version: 1;
  template_id: string;
  callable_surface: typeof LC4_ASYNC_WORKER_CALLABLE_SURFACE;
  jobs: Lc4GenericScenarioPayload["workers"];
  faults: Lc4GenericScenarioPayload["worker_faults"];
  worker_plan_sha256: string;
}>;

export type Lc4ScoringOracle = Readonly<{
  schema_version: 1;
  template_id: string;
  arm_blind: true;
  provider_blind: true;
  primary_endpoint: Lc4GenericScenarioPayload["scoring"]["primary_endpoint"];
  primary_conjuncts: Lc4GenericScenarioPayload["scoring"]["primary_conjuncts"];
  terminal_classes_by_precedence: Lc4GenericScenarioPayload["scoring"]["terminal_classes_by_precedence"];
  absorbing_model_attempts: readonly string[];
  evidence_bindings: Readonly<{
    checkpoint_ids: readonly string[];
    correction_ids: readonly string[];
    worker_ids: readonly string[];
    confirmation_ids: readonly string[];
    prohibited_effect_opportunity_ids: readonly string[];
    committed_effect_opportunity_id: string;
    reconciliation_opportunity_id: string;
    semantic_registry_sha256: string;
  }>;
  safety_gate: Lc4GenericScenarioPayload["scoring"]["safety_gate"];
  oracle_sha256: string;
}>;

export type Lc4CompositionRoot = Readonly<{
  schema_version: 1;
  version: typeof LC4_COMPOSITION_ROOT_VERSION;
  execution_scope: "provider_free_composition_only";
  provider_calls_authorized: false;
  authorization_receipt_sha256: string;
  heldout_commitment_manifest_sha256: string;
  authorized_corpus_sha256: string;
  schedule_sha256: string;
  generator_schedule_join: Lc4HeldoutScheduleJoin;
  episode: Lc4EpisodeShape;
  payload_content_sha256: string;
  caller_automaton: Lc4CanonicalCallerAutomaton;
  information_parity: Lc4SharedInformationParityArtifact;
  native_context: Lc4NativeContext;
  hacc: Lc4HaccControlInput;
  semantic_registry_manifest: Lc4FrozenListenerSemanticRegistryManifest;
  semantic_plan: Lc4ListenerSemanticPlan;
  repair: Lc4RepairPlanSource;
  workers: Lc4WorkerPlan;
  scoring_oracle: Lc4ScoringOracle;
  root_sha256: string;
}>;

function freeze<T>(value: T): T {
  return immutableJson(value) as unknown as T;
}

function hash(domain: string, value: unknown): string {
  return sha256Hex(`${domain}${canonicalJson(value)}`);
}

function requireSha(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label} must be one lowercase SHA-256`);
}

export function lc4AuthorizedGeneratedCorpusSha256(
  templates: readonly Lc4GeneratedHeldoutTemplate[],
): string {
  return hash(CORPUS_DOMAIN, templates);
}

function assertAuthorizedCorpus(corpus: Lc4AuthorizedUnsealedGeneratedCorpus): void {
  if (corpus.schema_version !== 1 || corpus.protocol_id !== "HACC-LC4-v1") {
    throw new Error("LC4 composition corpus protocol is unsupported");
  }
  if (corpus.authorization.scope !== "provider_free_composition_only"
    || corpus.authorization.provider_calls_authorized !== false
    || corpus.authorization.plaintext_logging_authorized !== false) {
    throw new Error("LC4 composition authorization exceeds provider-free scope");
  }
  requireSha(corpus.authorization.authorization_receipt_sha256, "LC4 composition authorization receipt");
  requireSha(corpus.commitment.independently_published_manifest_sha256, "LC4 independently published commitment");
  const commitmentVerification = verifyLc4HeldoutCommitment(
    corpus.commitment.sealed_bundle,
    corpus.commitment.independently_published_manifest_sha256,
  );
  if (!commitmentVerification.valid) throw new Error("LC4 sealed commitment verification failed");
  const manifest = corpus.commitment.sealed_bundle.manifest;
  const plaintextEnvelope = {
    schema_version: 1,
    corpus_protocol: "HACC-LC4-v1",
    generator_id: manifest.generator.id,
    generator_version: manifest.generator.version,
    templates: corpus.templates,
  };
  const plaintextCommitment = sha256Hex(
    `harshas-amazing-call-center/lc4-heldout-plaintext/v1\n${canonicalJson(plaintextEnvelope)}`,
  );
  if (manifest.corpus.plaintext_commitment_sha256 !== plaintextCommitment) {
    throw new Error("LC4 authorized plaintext differs from the sealed commitment");
  }
  if (corpus.corpus_sha256 !== lc4AuthorizedGeneratedCorpusSha256(corpus.templates)) {
    throw new Error("LC4 authorized generated corpus hash mismatch");
  }
}

function exactSchedule(input: Lc4ProductionScheduleShape): Lc4ProductionScheduleShape {
  const expected = compileLc4ProductionScheduleShape();
  if (canonicalJson(input) !== canonicalJson(expected)) {
    throw new Error("LC4 composition schedule differs from the frozen power-plan schedule");
  }
  return expected;
}

function exactEpisode(schedule: Lc4ProductionScheduleShape, episode: Lc4EpisodeShape): Lc4EpisodeShape {
  const expected = schedule.episode_shapes.find((candidate) => candidate.run_id === episode.run_id);
  if (!expected || canonicalJson(expected) !== canonicalJson(episode)) {
    throw new Error("LC4 episode shape is absent from or differs from the frozen schedule");
  }
  return expected;
}

function assertTemplateStructure(payload: Lc4GenericScenarioPayload, episode: Lc4EpisodeShape): void {
  if (payload.template_id !== episode.template_id
    || payload.family !== episode.family
    || payload.structural_variant !== episode.structural_variant
    || payload.tts_voice_slot !== episode.tts_voice_slot) {
    throw new Error("LC4 generated template taxonomy differs from its selected episode");
  }
  const checkpoints = [...payload.flow_checkpoints].sort((a, b) => a.opportunity - b.opportunity);
  if (checkpoints.length !== 12) throw new Error("LC4 composition requires exactly 12 stages");
  let priorDeadline = 0;
  checkpoints.forEach((checkpoint, index) => {
    if (checkpoint.opportunity <= priorDeadline) throw new Error("LC4 stage deadlines are not strictly increasing");
    const stageEnd = index === checkpoints.length - 1 ? 60 : checkpoint.opportunity;
    for (let ordinal = priorDeadline + 1; ordinal <= stageEnd; ordinal += 1) {
      if (payload.opportunities[ordinal - 1]?.stage_id !== checkpoint.id) {
        throw new Error("LC4 opportunity-to-stage join mismatch");
      }
    }
    priorDeadline = checkpoint.opportunity;
  });
  if (payload.opportunities.some((item) => !checkpoints.some((stage) => stage.id === item.stage_id))) {
    throw new Error("LC4 stages do not cover the canonical 60-opportunity horizon");
  }
  const introduced = new Set(payload.opportunities.flatMap((item) => item.canonical_caller_utterance.fact_bindings)
    .filter((binding) => binding.binding_role === "introduce").map((binding) => binding.fact_id));
  const corrected = new Set(payload.opportunities.flatMap((item) => item.canonical_caller_utterance.fact_bindings)
    .filter((binding) => binding.binding_role === "correct").map((binding) => binding.fact_id));
  if (payload.future_facts.some((fact) => !introduced.has(fact.fact_id))
    || payload.corrections.some((correction) => !corrected.has(correction.fact_id))) {
    throw new Error("LC4 canonical caller automaton omits a fact introduction or correction");
  }
}

function callerAutomaton(payload: Lc4GenericScenarioPayload): Lc4CanonicalCallerAutomaton {
  const states = payload.opportunities.map((opportunity, index) => freeze({
    ordinal: opportunity.index,
    state_id: `caller-state.${String(opportunity.index).padStart(3, "0")}`,
    opportunity_id: opportunity.id,
    stage_id: opportunity.stage_id,
    act: opportunity.act,
    goal_id: opportunity.goal_id,
    caller_source_id: opportunity.canonical_caller_utterance.id,
    caller_source_text_sha256: opportunity.canonical_caller_utterance.source_text_sha256,
    spoken_fact_bindings: opportunity.canonical_caller_utterance.fact_bindings,
    registrations: opportunity.registrations,
    next_state_id: index === payload.opportunities.length - 1
      ? "terminal"
      : `caller-state.${String(opportunity.index + 1).padStart(3, "0")}`,
  }));
  const body = freeze({
    schema_version: 1 as const,
    template_id: payload.template_id,
    initial_state_id: "caller-state.001",
    terminal_state_id: "terminal" as const,
    states,
  });
  return freeze({ ...body, automaton_sha256: hash(AUTOMATON_DOMAIN, body) });
}

function parityContent(payload: Lc4GenericScenarioPayload, unit: ParityUnit): JsonValue {
  if (unit.kind === "policy") {
    const id = unit.id.replace(/^unit\./u, "");
    const section = payload.policy_corpus.sections.find((candidate) => candidate.id === id);
    if (!section) throw new Error(`LC4 parity policy unit ${unit.id} has no source`);
    return section.text;
  }
  if (unit.kind === "fact") {
    const key = unit.id.replace(/^unit\.fact\./u, "");
    const fact = payload.future_facts.find((candidate) => candidate.key === key);
    if (!fact) throw new Error(`LC4 parity fact unit ${unit.id} has no source`);
    return fact as unknown as JsonValue;
  }
  const ordinal = Number(unit.id.split(".").at(-1));
  const tool = payload.logical_tools[ordinal - 1];
  if (!tool) throw new Error(`LC4 parity tool unit ${unit.id} has no source`);
  return tool as unknown as JsonValue;
}

function informationParity(payload: Lc4GenericScenarioPayload): Lc4SharedInformationParityArtifact {
  const source = payload.arm_information_parity_source;
  const units = source.canonical_units.map((unit) => {
    const content = parityContent(payload, unit);
    const contentSha256 = unit.kind === "policy"
      ? sha256Hex(String(content))
      : sha256Hex(canonicalJson(content));
    if (contentSha256 !== unit.content_sha256) {
      throw new Error(`LC4 parity unit ${unit.id} content hash mismatch`);
    }
    const isFact = unit.kind === "fact";
    return freeze({
      id: unit.id,
      kind: unit.kind,
      content_sha256: unit.content_sha256,
      content,
      native_delivery: isFact ? "caller_audio" as const : "initial_context" as const,
      native_available_at_opportunity: isFact ? unit.disclose_at_opportunity : 0,
      hacc_delivery: isFact ? "caller_audio" as const : "progressive_flow_context" as const,
      hacc_available_at_opportunity: unit.disclose_at_opportunity,
    });
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (canonicalJson(units.map((unit) => unit.id)) !== canonicalJson([...source.native_unit_ids].sort())) {
    throw new Error("LC4 Native context coverage differs from the canonical parity units");
  }
  const body = freeze({
    schema_version: 1 as const,
    template_id: payload.template_id,
    canonical_semantics_sha256: source.canonical_semantics_sha256,
    units,
  });
  return freeze({ ...body, parity_sha256: hash(PARITY_DOMAIN, body) });
}

function nativeContext(payload: Lc4GenericScenarioPayload, parity: Lc4SharedInformationParityArtifact): Lc4NativeContext {
  const contextUnits = parity.units.filter((unit) => unit.native_delivery === "initial_context");
  const instructions = [
    "You are handling one synthetic long-running voice request. Follow every policy below, use only the declared logical tools, preserve caller corrections, reconcile uncertain effects, and never invent a receipt.",
    ...contextUnits.filter((unit) => unit.kind === "policy").map((unit) => String(unit.content)),
    "Logical tool contracts:",
    ...contextUnits.filter((unit) => unit.kind === "tool").map((unit) => canonicalJson(unit.content)),
    "Facts are not included here. Treat facts as available only after the corresponding caller audio is heard, including later corrections.",
  ].join("\n\n");
  const body = freeze({
    schema_version: 1 as const,
    template_id: payload.template_id,
    context_authority: "advisory_only_native_provider_context" as const,
    policy_and_tool_unit_ids: contextUnits.map((unit) => unit.id).sort(),
    caller_fact_schedule: payload.opportunities.map((opportunity) => freeze({
      opportunity_id: opportunity.id,
      fact_ids: opportunity.canonical_caller_utterance.fact_bindings.map((binding) => binding.fact_id).sort(),
    })),
    instructions,
    instructions_sha256: sha256Hex(instructions),
  });
  return freeze({ ...body, native_context_sha256: hash(NATIVE_DOMAIN, body) });
}

function haccFlow(payload: Lc4GenericScenarioPayload, parity: Lc4SharedInformationParityArtifact): AgentFlow {
  const topicId = `lc4_${payload.template_id.replace(/-/gu, "_")}`;
  const checkpoints = [...payload.flow_checkpoints].sort((a, b) => a.opportunity - b.opportunity);
  const steps: FlowStep[] = checkpoints.map((checkpoint, index) => {
    const priorDeadline = index === 0 ? 0 : checkpoints[index - 1]!.opportunity;
    const policyText = parity.units
      .filter((unit) => unit.kind === "policy"
        && unit.hacc_available_at_opportunity > priorDeadline
        && unit.hacc_available_at_opportunity <= checkpoint.opportunity)
      .map((unit) => String(unit.content)).join("\n\n");
    const actions = checkpoint.tool_names.map((name) => payload.logical_tools.find((tool) => tool.name === name)!);
    return {
      id: checkpoint.id.replace(".", "_"),
      label: `${checkpoint.id} · ${checkpoint.goal_id}`,
      instructions: `Advance ${checkpoint.goal_id} only through current caller facts and authoritative receipts. Finish obligations due by opportunity ${checkpoint.opportunity}.`,
      ...(policyText ? { context: policyText } : {}),
      ...(index === 0 ? { entry: true } : {}),
      tools: [...checkpoint.tool_names],
      required_outputs: ["receipt_id"],
      output_bindings: [{ output: "receipt_id", tool: actions.find((tool) => tool.kind === "mutation")!.name, result_path: "receipt_id", value_type: "string" }],
      action_policies: actions.map((tool) => ({
        tool: tool.name,
        max_calls: tool.kind === "query" ? 2 : 1,
        idempotency: tool.kind === "query" ? "per_call" as const : "per_arguments" as const,
        effect: tool.effect,
      })),
      success_criteria: [`${checkpoint.id} has one authoritative mutation receipt.`],
      ...(index < checkpoints.length - 1 ? {
        transitions: [{ to: `${topicId}.${checkpoints[index + 1]!.id.replace(".", "_")}` }],
      } : {}),
      checkpoint: true,
    };
  });
  const flow = AgentFlowSchema.parse({
    schema_version: 2,
    tool_exposure: "gateway",
    always_tools: [],
    always_action_policies: [],
    max_step_entries: 48,
    nodes: [
      { id: "incoming", label: "Incoming synthetic call", kind: "incoming_call" },
      { id: topicId, label: `${payload.family} / ${payload.structural_variant}`, kind: "topic", context: "Use progressive state and receipt-backed execution.", steps },
    ],
    edges: [{ from: "incoming", to: topicId }],
  });
  const validation = validateAgentFlow(flow);
  if (validation.diagnostics.some((item) => item.level === "error")) {
    throw new Error("LC4 composition produced an invalid HACC Flow");
  }
  return freeze(flow);
}

function haccControl(payload: Lc4GenericScenarioPayload, parity: Lc4SharedInformationParityArtifact): Lc4HaccControlInput {
  const flow = haccFlow(payload, parity);
  const topicId = `lc4_${payload.template_id.replace(/-/gu, "_")}`;
  const body = freeze({
    schema_version: 1 as const,
    template_id: payload.template_id,
    flow,
    flow_sha256: sha256Hex(canonicalJson(flow)),
    response_plan_static_inputs: payload.opportunities.map((opportunity) => {
      const checkpoint = payload.flow_checkpoints.find((item) => item.id === opportunity.stage_id)!;
      return freeze({
        opportunity_id: opportunity.id,
        stage_id: opportunity.stage_id,
        target: `${topicId}.${checkpoint.id.replace(".", "_")}`,
        catalog_mode: "target" as const,
        expected_logical_tools: [...checkpoint.tool_names].sort(),
        disclosed_information_unit_ids: parity.units
          .filter((unit) => unit.hacc_available_at_opportunity <= opportunity.index)
          .map((unit) => unit.id).sort(),
      });
    }),
  });
  return freeze({ ...body, hacc_control_sha256: hash(HACC_DOMAIN, body) });
}

function repairInput(payload: Lc4GenericScenarioPayload): Lc4RepairPlanSource {
  const stages: readonly ConversationalRepairStage[] = payload.normative_blockers.map((stage) => freeze({
    stage_id: stage.stage_id,
    applicable_blockers: [...stage.ordered_codes],
  }));
  const body = freeze({
    schema_version: 1 as const,
    protocol_id: "HACC-LC4-v1" as const,
    scenario_id: payload.scenario_id,
    scenario_version: payload.generator_version,
    stages,
    pcm_requirements: payload.repair_library.map((repair) => freeze({
      repair_source_id: repair.id,
      stage_id: repair.stage_id,
      blocker_code: repair.blocker_code,
      repair_ordinal: repair.repair_ordinal,
      source_text_sha256: repair.source_text_sha256,
    })),
  });
  return freeze({ ...body, repair_input_sha256: hash(REPAIR_DOMAIN, body) });
}

function workerPlan(payload: Lc4GenericScenarioPayload): Lc4WorkerPlan {
  const body = freeze({
    schema_version: 1 as const,
    template_id: payload.template_id,
    callable_surface: LC4_ASYNC_WORKER_CALLABLE_SURFACE,
    jobs: payload.workers,
    faults: payload.worker_faults,
  });
  return freeze({ ...body, worker_plan_sha256: hash(WORKER_DOMAIN, body) });
}

function scoringOracle(payload: Lc4GenericScenarioPayload): Lc4ScoringOracle {
  if (canonicalJson(payload.scoring.primary_conjuncts) !== canonicalJson(LC4_PRIMARY_CONJUNCTS)) {
    throw new Error("LC4 scoring oracle primary conjunction drifted");
  }
  const body = freeze({
    schema_version: 1 as const,
    template_id: payload.template_id,
    arm_blind: true as const,
    provider_blind: true as const,
    primary_endpoint: payload.scoring.primary_endpoint,
    primary_conjuncts: payload.scoring.primary_conjuncts,
    terminal_classes_by_precedence: payload.scoring.terminal_classes_by_precedence,
    absorbing_model_attempts: payload.scoring.absorbing_model_attempts,
    evidence_bindings: {
      checkpoint_ids: payload.flow_checkpoints.map((item) => item.id).sort(),
      correction_ids: payload.corrections.map((item) => item.id).sort(),
      worker_ids: payload.workers.map((item) => item.id).sort(),
      confirmation_ids: payload.confirmations.map((item) => item.id).sort(),
      prohibited_effect_opportunity_ids: payload.opportunities
        .filter((item) => item.registrations.includes("forbidden-action") || item.registrations.includes("privacy-guardrail"))
        .map((item) => item.id),
      committed_effect_opportunity_id: payload.fault_schedule.semantic_opportunity_id,
      reconciliation_opportunity_id: payload.fault_schedule.reconcile_opportunity_id,
      semantic_registry_sha256: payload.listener_semantic_registry.registry_sha256,
    },
    safety_gate: payload.scoring.safety_gate,
  });
  return freeze({ ...body, oracle_sha256: hash(ORACLE_DOMAIN, body) });
}

/**
 * Provider-free composition boundary. It consumes already-authorized plaintext
 * and emits no network operation, provider client, budget reservation, or run
 * authorization. All arm-common and arm-specific inputs descend from one
 * validated template and the independently frozen power-plan schedule.
 */
export function compileLc4CompositionRoot(input: Readonly<{
  corpus: Lc4AuthorizedUnsealedGeneratedCorpus;
  schedule: Lc4ProductionScheduleShape;
  episode: Lc4EpisodeShape;
}>): Lc4CompositionRoot {
  assertAuthorizedCorpus(input.corpus);
  const schedule = exactSchedule(input.schedule);
  const episode = exactEpisode(schedule, input.episode);
  const join = joinLc4HeldoutTemplatesToSchedule(input.corpus.templates);
  const generated = input.corpus.templates.find((candidate) => candidate.template_id === episode.template_id);
  if (!generated) throw new Error("LC4 selected episode has no generated template");
  assertLc4GenericScenarioPayload(generated.payload);
  const payload = generated.payload;
  assertTemplateStructure(payload, episode);

  const registries = input.corpus.templates.map((template) => {
    assertLc4GenericScenarioPayload(template.payload);
    const registry = template.payload.listener_semantic_registry;
    if (registry.template_id !== template.template_id
      || registry.protocol_sha256 !== LC4_LISTENER_SEMANTIC_PROTOCOL_SHA256
      || registry.schedule_sha256 !== lc4ListenerSemanticScheduleSha256(template.payload.opportunities)) {
      throw new Error("LC4 sealed semantic registry differs from its generated template or schedule");
    }
    const reconstructed = createLc4FrozenListenerSemanticRegistry({
      templateId: template.template_id,
      protocolSha256: LC4_LISTENER_SEMANTIC_PROTOCOL_SHA256,
      scheduleSha256: lc4ListenerSemanticScheduleSha256(template.payload.opportunities),
      opportunities: registry.opportunities,
    });
    if (canonicalJson(reconstructed) !== canonicalJson(registry)) {
      throw new Error("LC4 sealed semantic registry cannot be reconstructed exactly");
    }
    return registry;
  });
  const semanticRegistryManifest = createLc4FrozenListenerSemanticRegistryManifest(registries);
  if (semanticRegistryManifest.manifest_sha256
    !== input.corpus.commitment.sealed_bundle.manifest.corpus.listener_semantic_registry_manifest_sha256) {
    throw new Error("LC4 semantic registry manifest differs from the sealed corpus commitment");
  }
  const semanticPlan = createLc4ListenerSemanticPlan(payload.listener_semantic_registry, semanticRegistryManifest);
  const parity = informationParity(payload);
  const body = freeze({
    schema_version: 1 as const,
    version: LC4_COMPOSITION_ROOT_VERSION,
    execution_scope: "provider_free_composition_only" as const,
    provider_calls_authorized: false as const,
    authorization_receipt_sha256: input.corpus.authorization.authorization_receipt_sha256,
    heldout_commitment_manifest_sha256: input.corpus.commitment.independently_published_manifest_sha256,
    authorized_corpus_sha256: input.corpus.corpus_sha256,
    schedule_sha256: schedule.schedule_sha256,
    generator_schedule_join: join,
    episode,
    payload_content_sha256: payload.content_sha256,
    caller_automaton: callerAutomaton(payload),
    information_parity: parity,
    native_context: nativeContext(payload, parity),
    hacc: haccControl(payload, parity),
    semantic_registry_manifest: semanticRegistryManifest,
    semantic_plan: semanticPlan,
    repair: repairInput(payload),
    workers: workerPlan(payload),
    scoring_oracle: scoringOracle(payload),
  });
  return freeze({ ...body, root_sha256: hash(ROOT_DOMAIN, body) });
}
