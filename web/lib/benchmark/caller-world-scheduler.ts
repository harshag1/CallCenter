import {
  appendEventEnvelope,
  canonicalJson,
  immutableJson,
  sha256Hex,
  startEventChain,
  verifyEventChain,
  type BenchmarkEventEnvelope,
  type JsonValue as ArtifactJsonValue,
} from "./artifacts";
import {
  CapabilityGatewayCallSchema,
  type CapabilityGatewayCall,
} from "./capability-gateway";
import {
  BenchmarkScenarioSchema,
  type BenchmarkScenario,
  type JsonValue,
  type WorldReceipt,
} from "./scenario-schema";
import {
  ToolWorldStateSchema,
  type ToolWorldState,
} from "./tool-world";
import type {
  CallerAudioFixtureManifest,
  CallerAudioRendition,
  VerifiedFrozenCallerAudio,
} from "./audio-fixtures";

const FLAT_FACT_ID = /^[a-z][a-z0-9_-]{1,95}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const OPPORTUNITY_ID = /^[a-z][a-z0-9_.-]{1,95}$/;
const OBSERVATION_HASH_DOMAIN = "harshas-amazing-call-center/caller-observation/v1\n";
const DELIVERY_HASH_DOMAIN = "harshas-amazing-call-center/caller-delivery/v1\n";
const SCHEDULE_HASH_DOMAIN = "harshas-amazing-call-center/caller-schedule/v1\n";

type CallerTurn = BenchmarkScenario["caller"]["turns"][number];

export type FrozenCallerAudioReference = Readonly<{
  turn_id: string;
  fixture_set_id: string;
  fixture_manifest_sha256: string;
  source_text_sha256: string;
  rendition: CallerAudioRendition;
  pcm_sha256: string;
  byte_length: number;
  sample_rate_hz: 16_000 | 24_000;
  channels: 1;
  encoding: "pcm16";
}>;

export type FrozenCallerAudioIndex = Readonly<{
  schema_version: 1;
  scenario_id: string;
  scenario_version: string;
  fixture_set_id: string;
  fixture_manifest_sha256: string;
  rendition: CallerAudioRendition;
  turns: Readonly<Record<string, FrozenCallerAudioReference>>;
}>;

export type CallerFactValueContract = Readonly<{
  type: "string" | "number" | "boolean" | "object" | "array" | "null";
  enum?: readonly JsonValue[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
}>;

/**
 * `fact_id` is scenario vocabulary. `world_fact_key` is a separately declared,
 * flat destination key. A model- or scenario-supplied string is never treated
 * as an object path.
 */
export type CallerFactAllowlistRule = Readonly<{
  fact_id: string;
  world_fact_key: string;
  contract: CallerFactValueContract;
}>;

export type CallerSelectionPredicate =
  | Readonly<{ kind: "world_fact_equals"; fact_key: string; value: JsonValue }>
  | Readonly<{ kind: "world_fact_exists"; fact_key: string }>
  | Readonly<{ kind: "caller_fact_equals"; fact_id: string; value: JsonValue }>
  | Readonly<{ kind: "caller_fact_revision_at_least"; fact_id: string; revision: number }>
  | Readonly<{ kind: "effect_count_at_least"; tool: string; count: number }>
  | Readonly<{
      kind: "receipt_count_at_least";
      tool: string;
      count: number;
      status?: WorldReceipt["status"];
      committed?: boolean;
    }>
  | Readonly<{ kind: "turn_committed"; turn_id: string }>;

export type CallerStageCandidate = Readonly<{
  turn_id: string;
  audio_turn_id: string;
  when: readonly CallerSelectionPredicate[];
}>;

export type CallerStage = Readonly<{
  id: string;
  candidates: readonly CallerStageCandidate[];
}>;

export type OpportunityTrigger =
  | Readonly<{ boundary: "before_turn" | "after_turn"; turn_id: string }>
  | Readonly<{
      boundary: "after_receipt";
      tool: string;
      occurrence: number;
      status?: WorldReceipt["status"];
      committed?: boolean;
    }>;

export type ReconnectOpportunitySpec = Readonly<{
  id: string;
  kind: "reconnect";
  trigger: OpportunityTrigger;
  reconnect_mode: "warm" | "cold";
}>;

export type InterruptionOpportunitySpec = Readonly<{
  id: string;
  kind: "interruption";
  trigger: OpportunityTrigger;
  after_output_ms: number;
  reason: string;
}>;

export type DeliveryReplayMode =
  | "exact_same_call_id"
  | "new_id_semantic_duplicate"
  | "stale_grant_replay";

export type GatewayDeliveryOpportunitySpec = Readonly<{
  id: string;
  kind: "gateway_delivery";
  trigger: OpportunityTrigger;
  delivery_mode: DeliveryReplayMode;
}>;

export type CallerOpportunitySpec =
  | ReconnectOpportunitySpec
  | InterruptionOpportunitySpec
  | GatewayDeliveryOpportunitySpec;

export type CallerWorldSchedulePlan = Readonly<{
  schema_version: 1;
  run_id: string;
  created_at: string;
  scenario: unknown;
  audio: FrozenCallerAudioIndex;
  fact_allowlist: readonly CallerFactAllowlistRule[];
  observable_world_fact_keys: readonly string[];
  /** Omit to produce one unconditional stage per canonical caller turn. */
  stages?: readonly CallerStage[];
  opportunities: readonly CallerOpportunitySpec[];
}>;

export type ObservableReceipt = Readonly<{
  receipt_id: string;
  invocation_id: string;
  tool: string;
  status: WorldReceipt["status"];
  committed: boolean;
  turn: number;
}>;

export type ObservableEffect = Readonly<{
  effect_id: string;
  invocation_id: string;
  tool: string;
}>;

/** The only runtime observation accepted by caller-selection logic. */
export type CallerWorldObservation = Readonly<{
  schema_version: 1;
  world_revision: number;
  facts: Readonly<Record<string, JsonValue>>;
  receipts: readonly ObservableReceipt[];
  effects: readonly ObservableEffect[];
}>;

export type CallerFactState = Readonly<{
  fact_id: string;
  world_fact_key: string;
  value: JsonValue;
  revision: number;
  source_turn_id: string;
  evidence_hash: string;
}>;

export type PendingCallerTurn = Readonly<{
  selection_id: string;
  stage_id: string;
  turn_id: string;
  audio_turn_id: string;
  selected_at_world_revision: number;
  observation_sha256: string;
}>;

export type CallerSchedulerState = Readonly<{
  schema_version: 1;
  run_id: string;
  scenario_id: string;
  scenario_version: string;
  schedule_sha256: string;
  scheduler_revision: number;
  stage_index: number;
  pending_turn: PendingCallerTurn | null;
  committed_turn_ids: readonly string[];
  caller_facts: Readonly<Record<string, CallerFactState>>;
  fired_opportunity_ids: readonly string[];
  evidence: readonly BenchmarkEventEnvelope[];
}>;

export type TrustedCallerWorldEvent = Readonly<{
  schema_version: 1;
  type: "caller.world_fact_asserted" | "caller.world_fact_superseded";
  authority: "caller_reported";
  trusted: true;
  fact_id: string;
  world_fact_key: string;
  value: JsonValue;
  revision: number;
  previous_revision: number;
  source_turn_id: string;
  turn_boundary: number;
  scheduler_revision: number;
  supersedes?: JsonValue;
}>;

export type ScheduledReconnectOpportunity = Readonly<{
  id: string;
  kind: "reconnect";
  trigger: OpportunityTrigger;
  reconnect_mode: "warm" | "cold";
  observation_sha256: string;
}>;

export type ScheduledInterruptionOpportunity = Readonly<{
  id: string;
  kind: "interruption";
  trigger: OpportunityTrigger;
  after_output_ms: number;
  reason: string;
  observation_sha256: string;
}>;

export type ScheduledGatewayDeliveryOpportunity = Readonly<{
  id: string;
  kind: "gateway_delivery";
  trigger: OpportunityTrigger;
  delivery_mode: DeliveryReplayMode;
  source_receipt_id: string;
  observation_sha256: string;
}>;

export type ScheduledCallerOpportunity =
  | ScheduledReconnectOpportunity
  | ScheduledInterruptionOpportunity
  | ScheduledGatewayDeliveryOpportunity;

export type CallerTurnSelection = Readonly<{
  selection_id: string;
  stage_id: string;
  turn_id: string;
  utterance: string;
  audio: FrozenCallerAudioReference;
  observation_sha256: string;
}>;

export type SelectCallerTurnResult =
  | Readonly<{ status: "complete"; state: CallerSchedulerState }>
  | Readonly<{
      status: "blocked";
      state: CallerSchedulerState;
      stage_id: string;
      unmet: readonly string[];
    }>
  | Readonly<{
      status: "selected";
      state: CallerSchedulerState;
      selection: CallerTurnSelection;
      opportunities: readonly ScheduledCallerOpportunity[];
      evidence: readonly BenchmarkEventEnvelope[];
    }>;

export type CommitCallerTurnResult = Readonly<{
  state: CallerSchedulerState;
  world_events: readonly TrustedCallerWorldEvent[];
  opportunities: readonly ScheduledCallerOpportunity[];
  evidence: readonly BenchmarkEventEnvelope[];
}>;

export type PollCallerOpportunitiesResult = Readonly<{
  state: CallerSchedulerState;
  opportunities: readonly ScheduledCallerOpportunity[];
  evidence: readonly BenchmarkEventEnvelope[];
}>;

export type RecordedGatewayCall = Readonly<{
  receipt_id: string;
  provider_call_id: string;
  call: CapabilityGatewayCall;
  /** Below-provider host authority captured separately from model arguments. */
  host_authority: Readonly<{
    capability_epoch: number;
    capability_grant: string;
  }>;
}>;

export type MaterializedGatewayDelivery = Readonly<{
  opportunity_id: string;
  delivery_mode: DeliveryReplayMode;
  source_provider_call_id: string;
  emitted_provider_call_id: string;
  source_capability_epoch: number;
  emitted_capability_epoch: number;
  observed_current_capability_epoch: number;
  /** Exact provider stimulus. It can never carry host authority. */
  call: CapabilityGatewayCall;
  /** Fault injection seam below the provider/model boundary. */
  host_authority: Readonly<{
    capability_epoch: number;
    capability_grant: string;
  }>;
  relation: Readonly<{
    same_call_id: boolean;
    same_semantic_intent: true;
    grant: "exact_original" | "current" | "stale_original";
  }>;
  evidence: Readonly<{
    schema_version: 1;
    type: "gateway.delivery_materialized";
    opportunity_id: string;
    delivery_mode: DeliveryReplayMode;
    source_provider_call_id: string;
    emitted_provider_call_id: string;
    source_call_sha256: string;
    emitted_call_sha256: string;
    semantic_intent_sha256: string;
    source_host_authority_sha256: string;
    emitted_host_authority_sha256: string;
    grant_relation: "exact_original" | "current" | "stale_original";
  }>;
}>;

export type DeterministicCallerWorldScheduler = Readonly<{
  scenario: BenchmarkScenario;
  initialState: CallerSchedulerState;
  selectNext(input: Readonly<{
    state: CallerSchedulerState;
    observation: CallerWorldObservation;
    observed_at: string;
  }>): SelectCallerTurnResult;
  commitTurn(input: Readonly<{
    state: CallerSchedulerState;
    selection_id: string;
    observation: CallerWorldObservation;
    observed_at: string;
  }>): CommitCallerTurnResult;
  pollOpportunities(input: Readonly<{
    state: CallerSchedulerState;
    observation: CallerWorldObservation;
    observed_at: string;
  }>): PollCallerOpportunitiesResult;
}>;

type NormalizedPlan = Readonly<{
  runId: string;
  scenario: BenchmarkScenario;
  scheduleHash: string;
  audio: FrozenCallerAudioIndex;
  factRules: ReadonlyMap<string, CallerFactAllowlistRule>;
  observableWorldFacts: ReadonlySet<string>;
  stages: readonly CallerStage[];
  opportunities: readonly CallerOpportunitySpec[];
}>;

function asImmutable<T>(value: T): T {
  return immutableJson(value) as unknown as T;
}

function assertPlainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
}

function assertOnlyKeys(value: unknown, allowed: readonly string[], label: string): void {
  assertPlainRecord(value, label);
  const allow = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allow.has(key)) throw new Error(`${label} contains unsupported key ${JSON.stringify(key)}`);
  }
}

function assertNonEmpty(value: unknown, label: string, maxLength = 512): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(`${label} must be a non-empty string of at most ${maxLength} characters`);
  }
}

function assertFlatFactId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !FLAT_FACT_ID.test(value)) {
    throw new Error(`${label} must be a flat allowlisted identifier; object paths are forbidden`);
  }
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function valueType(value: JsonValue): CallerFactValueContract["type"] {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value as "string" | "number" | "boolean" | "object";
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertValueContract(value: JsonValue, contract: CallerFactValueContract, label: string): void {
  if (valueType(value) !== contract.type) {
    throw new Error(`${label} must be ${contract.type}`);
  }
  if (contract.enum && !contract.enum.some((candidate) => sameJson(candidate, value))) {
    throw new Error(`${label} is outside its allowlisted enum`);
  }
  if (contract.pattern !== undefined) {
    if (contract.type !== "string") throw new Error(`${label} uses a pattern with a non-string contract`);
    let matcher: RegExp;
    try {
      matcher = new RegExp(contract.pattern);
    } catch {
      throw new Error(`${label} has an invalid regular-expression contract`);
    }
    if (!matcher.test(value as string)) throw new Error(`${label} does not match its allowlisted pattern`);
  }
  if (contract.minimum !== undefined || contract.maximum !== undefined) {
    if (contract.type !== "number") throw new Error(`${label} uses numeric bounds with a non-number contract`);
    const number = value as number;
    if (contract.minimum !== undefined && number < contract.minimum) throw new Error(`${label} is below its minimum`);
    if (contract.maximum !== undefined && number > contract.maximum) throw new Error(`${label} is above its maximum`);
  }
}

function validateAudioReference(reference: FrozenCallerAudioReference, label: string): void {
  assertOnlyKeys(reference, [
    "turn_id",
    "fixture_set_id",
    "fixture_manifest_sha256",
    "source_text_sha256",
    "rendition",
    "pcm_sha256",
    "byte_length",
    "sample_rate_hz",
    "channels",
    "encoding",
  ], label);
  assertNonEmpty(reference.turn_id, `${label}.turn_id`, 256);
  assertNonEmpty(reference.fixture_set_id, `${label}.fixture_set_id`, 256);
  for (const [field, digest] of [
    ["fixture_manifest_sha256", reference.fixture_manifest_sha256],
    ["source_text_sha256", reference.source_text_sha256],
    ["pcm_sha256", reference.pcm_sha256],
  ] as const) {
    if (!SHA256.test(digest)) throw new Error(`${label}.${field} must be a lowercase SHA-256 digest`);
  }
  if (!["pcm16le_mono_16000", "pcm16le_mono_24000"].includes(reference.rendition)) {
    throw new Error(`${label}.rendition is unsupported`);
  }
  assertPositiveInteger(reference.byte_length, `${label}.byte_length`);
  if (![16_000, 24_000].includes(reference.sample_rate_hz)) throw new Error(`${label}.sample_rate_hz is unsupported`);
  if (reference.channels !== 1 || reference.encoding !== "pcm16") throw new Error(`${label} must be mono PCM16`);
}

/** Build selection-only metadata from an already verified fixture. */
export function frozenAudioIndexFromVerifiedFixture(
  fixture: VerifiedFrozenCallerAudio,
  rendition: CallerAudioRendition
): FrozenCallerAudioIndex {
  return freezeCallerAudioIndexFromManifest(fixture.manifest, rendition);
}

/**
 * This lower-level adapter is useful when manifest verification happened in a
 * different process. Paid trials should prefer `frozenAudioIndexFromVerifiedFixture`.
 */
export function freezeCallerAudioIndexFromManifest(
  manifest: CallerAudioFixtureManifest,
  rendition: CallerAudioRendition
): FrozenCallerAudioIndex {
  const turns: Record<string, FrozenCallerAudioReference> = {};
  for (const turn of manifest.turns) {
    const pcm = turn.renditions[rendition];
    if (turns[turn.caller_turn_id]) throw new Error(`duplicate frozen audio turn ${turn.caller_turn_id}`);
    turns[turn.caller_turn_id] = {
      turn_id: turn.caller_turn_id,
      fixture_set_id: manifest.fixture_set_id,
      fixture_manifest_sha256: manifest.manifest_sha256,
      source_text_sha256: turn.source_text_utf8_sha256,
      rendition,
      pcm_sha256: pcm.sha256,
      byte_length: pcm.byte_length,
      sample_rate_hz: pcm.sample_rate_hz,
      channels: 1,
      encoding: "pcm16",
    };
  }
  return freezeCallerAudioIndex({
    schema_version: 1,
    scenario_id: manifest.scenario.id,
    scenario_version: manifest.scenario.version,
    fixture_set_id: manifest.fixture_set_id,
    fixture_manifest_sha256: manifest.manifest_sha256,
    rendition,
    turns,
  });
}

/** Validate and deeply freeze a detached audio descriptor index. */
export function freezeCallerAudioIndex(input: FrozenCallerAudioIndex): FrozenCallerAudioIndex {
  assertOnlyKeys(input, [
    "schema_version",
    "scenario_id",
    "scenario_version",
    "fixture_set_id",
    "fixture_manifest_sha256",
    "rendition",
    "turns",
  ], "audio index");
  if (input.schema_version !== 1) throw new Error("unsupported audio index schema");
  assertNonEmpty(input.scenario_id, "audio index scenario_id", 256);
  assertNonEmpty(input.scenario_version, "audio index scenario_version", 128);
  assertNonEmpty(input.fixture_set_id, "audio index fixture_set_id", 256);
  if (!SHA256.test(input.fixture_manifest_sha256)) throw new Error("audio index manifest hash is invalid");
  assertPlainRecord(input.turns, "audio index turns");
  for (const [turnId, reference] of Object.entries(input.turns)) {
    validateAudioReference(reference, `audio index turn ${turnId}`);
    if (turnId !== reference.turn_id) throw new Error(`audio index key ${turnId} does not match its turn_id`);
    if (
      reference.fixture_set_id !== input.fixture_set_id
      || reference.fixture_manifest_sha256 !== input.fixture_manifest_sha256
      || reference.rendition !== input.rendition
    ) {
      throw new Error(`audio index turn ${turnId} belongs to a different frozen fixture`);
    }
  }
  return asImmutable(input);
}

function normalizeFactRules(rules: readonly CallerFactAllowlistRule[]): ReadonlyMap<string, CallerFactAllowlistRule> {
  const normalized = new Map<string, CallerFactAllowlistRule>();
  const worldKeys = new Set<string>();
  for (const [index, rule] of rules.entries()) {
    assertOnlyKeys(rule, ["fact_id", "world_fact_key", "contract"], `fact_allowlist[${index}]`);
    assertFlatFactId(rule.fact_id, `fact_allowlist[${index}].fact_id`);
    assertFlatFactId(rule.world_fact_key, `fact_allowlist[${index}].world_fact_key`);
    if (normalized.has(rule.fact_id)) throw new Error(`duplicate caller fact rule ${rule.fact_id}`);
    if (worldKeys.has(rule.world_fact_key)) throw new Error(`duplicate caller world fact key ${rule.world_fact_key}`);
    worldKeys.add(rule.world_fact_key);
    assertOnlyKeys(rule.contract, ["type", "enum", "pattern", "minimum", "maximum"], `fact rule ${rule.fact_id}.contract`);
    if (!["string", "number", "boolean", "object", "array", "null"].includes(rule.contract.type)) {
      throw new Error(`fact rule ${rule.fact_id} has an unsupported type`);
    }
    if (rule.contract.enum) {
      if (rule.contract.enum.length === 0) throw new Error(`fact rule ${rule.fact_id} has an empty enum`);
      for (const value of rule.contract.enum) assertValueContract(value, { type: rule.contract.type }, `fact rule ${rule.fact_id} enum value`);
    }
    if (rule.contract.pattern !== undefined) {
      if (rule.contract.type !== "string") throw new Error(`fact rule ${rule.fact_id} pattern requires string type`);
      try { new RegExp(rule.contract.pattern); } catch { throw new Error(`fact rule ${rule.fact_id} pattern is invalid`); }
    }
    if (rule.contract.minimum !== undefined || rule.contract.maximum !== undefined) {
      if (rule.contract.type !== "number") throw new Error(`fact rule ${rule.fact_id} numeric bounds require number type`);
      if (
        rule.contract.minimum !== undefined
        && rule.contract.maximum !== undefined
        && rule.contract.minimum > rule.contract.maximum
      ) throw new Error(`fact rule ${rule.fact_id} minimum exceeds maximum`);
    }
    normalized.set(rule.fact_id, asImmutable(rule));
  }
  return normalized;
}

function defaultStages(scenario: BenchmarkScenario): readonly CallerStage[] {
  return Object.freeze(scenario.caller.turns.map((turn, index) => asImmutable({
    id: `stage-${String(index + 1).padStart(3, "0")}`,
    candidates: [{ turn_id: turn.id, audio_turn_id: turn.id, when: [] }],
  })));
}

function validatePredicate(
  predicate: CallerSelectionPredicate,
  plan: Readonly<{
    observableWorldFacts: ReadonlySet<string>;
    factRules: ReadonlyMap<string, CallerFactAllowlistRule>;
    turnIds: ReadonlySet<string>;
    toolNames: ReadonlySet<string>;
  }>,
  label: string
): void {
  switch (predicate.kind) {
    case "world_fact_equals":
      assertOnlyKeys(predicate, ["kind", "fact_key", "value"], label);
      assertFlatFactId(predicate.fact_key, `${label}.fact_key`);
      if (!plan.observableWorldFacts.has(predicate.fact_key)) throw new Error(`${label} references unobservable world fact ${predicate.fact_key}`);
      break;
    case "world_fact_exists":
      assertOnlyKeys(predicate, ["kind", "fact_key"], label);
      assertFlatFactId(predicate.fact_key, `${label}.fact_key`);
      if (!plan.observableWorldFacts.has(predicate.fact_key)) throw new Error(`${label} references unobservable world fact ${predicate.fact_key}`);
      break;
    case "caller_fact_equals":
      assertOnlyKeys(predicate, ["kind", "fact_id", "value"], label);
      if (!plan.factRules.has(predicate.fact_id)) throw new Error(`${label} references unallowlisted caller fact ${predicate.fact_id}`);
      break;
    case "caller_fact_revision_at_least":
      assertOnlyKeys(predicate, ["kind", "fact_id", "revision"], label);
      if (!plan.factRules.has(predicate.fact_id)) throw new Error(`${label} references unallowlisted caller fact ${predicate.fact_id}`);
      assertPositiveInteger(predicate.revision, `${label}.revision`);
      break;
    case "effect_count_at_least":
      assertOnlyKeys(predicate, ["kind", "tool", "count"], label);
      if (!plan.toolNames.has(predicate.tool)) throw new Error(`${label} references unknown tool ${predicate.tool}`);
      assertNonNegativeInteger(predicate.count, `${label}.count`);
      break;
    case "receipt_count_at_least":
      assertOnlyKeys(predicate, ["kind", "tool", "count", "status", "committed"], label);
      if (!plan.toolNames.has(predicate.tool)) throw new Error(`${label} references unknown tool ${predicate.tool}`);
      assertNonNegativeInteger(predicate.count, `${label}.count`);
      break;
    case "turn_committed":
      assertOnlyKeys(predicate, ["kind", "turn_id"], label);
      if (!plan.turnIds.has(predicate.turn_id)) throw new Error(`${label} references unknown turn ${predicate.turn_id}`);
      break;
    default: {
      const neverPredicate: never = predicate;
      throw new Error(`${label} has unknown predicate ${(neverPredicate as { kind?: unknown }).kind}`);
    }
  }
}

function normalizeStages(
  input: readonly CallerStage[] | undefined,
  scenario: BenchmarkScenario,
  audio: FrozenCallerAudioIndex,
  factRules: ReadonlyMap<string, CallerFactAllowlistRule>,
  observableWorldFacts: ReadonlySet<string>
): readonly CallerStage[] {
  const stages = input ?? defaultStages(scenario);
  if (stages.length === 0) throw new Error("caller schedule requires at least one stage");
  const stageIds = new Set<string>();
  const scheduledTurns = new Set<string>();
  const turnIds = new Set(scenario.caller.turns.map((turn) => turn.id));
  const toolNames = new Set(scenario.tools.map((tool) => tool.name));
  const normalized: CallerStage[] = [];
  for (const [stageIndex, stage] of stages.entries()) {
    assertOnlyKeys(stage, ["id", "candidates"], `stages[${stageIndex}]`);
    if (!OPPORTUNITY_ID.test(stage.id)) throw new Error(`stages[${stageIndex}].id is invalid`);
    if (stageIds.has(stage.id)) throw new Error(`duplicate caller stage ${stage.id}`);
    stageIds.add(stage.id);
    if (stage.candidates.length === 0) throw new Error(`caller stage ${stage.id} has no candidates`);
    const candidates: CallerStageCandidate[] = [];
    for (const [candidateIndex, candidate] of stage.candidates.entries()) {
      const label = `stage ${stage.id} candidate ${candidateIndex}`;
      assertOnlyKeys(candidate, ["turn_id", "audio_turn_id", "when"], label);
      if (!turnIds.has(candidate.turn_id)) throw new Error(`${label} references unknown caller turn ${candidate.turn_id}`);
      if (!audio.turns[candidate.audio_turn_id]) throw new Error(`${label} references missing frozen audio ${candidate.audio_turn_id}`);
      if (scheduledTurns.has(candidate.turn_id)) throw new Error(`caller turn ${candidate.turn_id} appears in more than one stage`);
      scheduledTurns.add(candidate.turn_id);
      candidate.when.forEach((predicate, predicateIndex) => validatePredicate(predicate, {
        observableWorldFacts,
        factRules,
        turnIds,
        toolNames,
      }, `${label}.when[${predicateIndex}]`));
      candidates.push(asImmutable(candidate));
    }
    normalized.push(asImmutable({ id: stage.id, candidates }));
  }
  return Object.freeze(normalized);
}

function validateOpportunity(
  opportunity: CallerOpportunitySpec,
  turnIds: ReadonlySet<string>,
  toolNames: ReadonlySet<string>,
  label: string
): void {
  if (!OPPORTUNITY_ID.test(opportunity.id)) throw new Error(`${label}.id is invalid`);
  if (opportunity.kind === "reconnect") {
    assertOnlyKeys(opportunity, ["id", "kind", "trigger", "reconnect_mode"], label);
    if (!["warm", "cold"].includes(opportunity.reconnect_mode)) throw new Error(`${label}.reconnect_mode is invalid`);
  } else if (opportunity.kind === "interruption") {
    assertOnlyKeys(opportunity, ["id", "kind", "trigger", "after_output_ms", "reason"], label);
    assertNonNegativeInteger(opportunity.after_output_ms, `${label}.after_output_ms`);
    assertNonEmpty(opportunity.reason, `${label}.reason`);
    if (opportunity.trigger.boundary !== "before_turn") {
      throw new Error(`${label} interruptions must be anchored before the interrupting caller turn`);
    }
  } else if (opportunity.kind === "gateway_delivery") {
    assertOnlyKeys(opportunity, ["id", "kind", "trigger", "delivery_mode"], label);
    if (opportunity.trigger.boundary !== "after_receipt") {
      throw new Error(`${label} gateway deliveries must be anchored after an authoritative receipt`);
    }
    if (![
      "exact_same_call_id",
      "new_id_semantic_duplicate",
      "stale_grant_replay",
    ].includes(opportunity.delivery_mode)) throw new Error(`${label}.delivery_mode is invalid`);
  } else {
    throw new Error(`${label}.kind is invalid`);
  }
  const trigger = opportunity.trigger;
  if (trigger.boundary === "after_receipt") {
    assertOnlyKeys(trigger, ["boundary", "tool", "occurrence", "status", "committed"], `${label}.trigger`);
    if (!toolNames.has(trigger.tool)) throw new Error(`${label} references unknown tool ${trigger.tool}`);
    assertPositiveInteger(trigger.occurrence, `${label}.trigger.occurrence`);
  } else {
    assertOnlyKeys(trigger, ["boundary", "turn_id"], `${label}.trigger`);
    if (!turnIds.has(trigger.turn_id)) throw new Error(`${label} references unknown turn ${trigger.turn_id}`);
  }
}

function normalizePlan(input: CallerWorldSchedulePlan): NormalizedPlan {
  assertOnlyKeys(input, [
    "schema_version",
    "run_id",
    "created_at",
    "scenario",
    "audio",
    "fact_allowlist",
    "observable_world_fact_keys",
    "stages",
    "opportunities",
  ], "caller world schedule plan");
  if (input.schema_version !== 1) throw new Error("unsupported caller schedule schema");
  assertNonEmpty(input.run_id, "caller schedule run_id", 256);
  const scenario = BenchmarkScenarioSchema.parse(input.scenario);
  const audio = freezeCallerAudioIndex(input.audio);
  if (audio.scenario_id !== scenario.id || audio.scenario_version !== scenario.version) {
    throw new Error("caller audio index belongs to a different scenario revision");
  }
  for (const turn of scenario.caller.turns) {
    if (!audio.turns[turn.id]) throw new Error(`frozen caller audio is missing canonical turn ${turn.id}`);
  }
  const factRules = normalizeFactRules(input.fact_allowlist);
  const usedFacts = new Set<string>();
  for (const turn of scenario.caller.turns) {
    const withinTurn = new Set<string>();
    for (const update of turn.fact_updates) {
      if (!factRules.has(update.fact)) throw new Error(`caller turn ${turn.id} updates unallowlisted fact ${update.fact}`);
      if (withinTurn.has(update.fact)) throw new Error(`caller turn ${turn.id} updates fact ${update.fact} more than once`);
      withinTurn.add(update.fact);
      usedFacts.add(update.fact);
      const rule = factRules.get(update.fact)!;
      assertValueContract(update.value, rule.contract, `caller turn ${turn.id} fact ${update.fact}`);
      if (Object.prototype.hasOwnProperty.call(update, "supersedes")) {
        assertValueContract(update.supersedes!, rule.contract, `caller turn ${turn.id} supersedes ${update.fact}`);
      }
    }
  }
  for (const factId of factRules.keys()) {
    if (!usedFacts.has(factId)) throw new Error(`caller fact rule ${factId} is never used by a canonical turn`);
  }
  const observableWorldFacts = new Set<string>();
  for (const [index, key] of input.observable_world_fact_keys.entries()) {
    assertFlatFactId(key, `observable_world_fact_keys[${index}]`);
    if (observableWorldFacts.has(key)) throw new Error(`duplicate observable world fact ${key}`);
    observableWorldFacts.add(key);
  }
  const stages = normalizeStages(input.stages, scenario, audio, factRules, observableWorldFacts);
  const opportunityIds = new Set<string>();
  const turnIds = new Set(scenario.caller.turns.map((turn) => turn.id));
  const toolNames = new Set(scenario.tools.map((tool) => tool.name));
  const opportunities = input.opportunities.map((opportunity, index) => {
    validateOpportunity(opportunity, turnIds, toolNames, `opportunities[${index}]`);
    if (opportunityIds.has(opportunity.id)) throw new Error(`duplicate opportunity ${opportunity.id}`);
    opportunityIds.add(opportunity.id);
    return asImmutable(opportunity);
  });
  const scheduleHash = sha256Hex(`${SCHEDULE_HASH_DOMAIN}${canonicalJson({
    schema_version: 1,
    scenario,
    audio,
    fact_allowlist: [...factRules.values()],
    observable_world_fact_keys: [...observableWorldFacts].sort(),
    stages,
    opportunities,
  })}`);
  return Object.freeze({
    runId: input.run_id,
    scenario,
    scheduleHash,
    audio,
    factRules,
    observableWorldFacts,
    stages,
    opportunities: Object.freeze(opportunities),
  });
}

/**
 * Strip a tool world down to the condition-blind fields caller policy may see.
 * Arbitrary result payloads, prompts, grants, model output, and condition IDs
 * are deliberately absent.
 */
export function observeCallerWorld(
  worldInput: ToolWorldState,
  allowedWorldFactKeys: readonly string[]
): CallerWorldObservation {
  const world = ToolWorldStateSchema.parse(worldInput);
  const allowed = new Set<string>();
  for (const [index, key] of allowedWorldFactKeys.entries()) {
    assertFlatFactId(key, `allowedWorldFactKeys[${index}]`);
    if (allowed.has(key)) throw new Error(`duplicate allowed world fact ${key}`);
    allowed.add(key);
  }
  const facts: Record<string, JsonValue> = {};
  for (const key of [...allowed].sort()) {
    if (Object.prototype.hasOwnProperty.call(world.facts, key)) facts[key] = structuredClone(world.facts[key]);
  }
  return asImmutable({
    schema_version: 1,
    world_revision: Math.max(0, world.next_event_sequence - 1),
    facts,
    receipts: world.receipts.map((receipt) => ({
      receipt_id: receipt.receipt_id,
      invocation_id: receipt.invocation_id,
      tool: receipt.tool,
      status: receipt.status,
      committed: receipt.committed,
      turn: receipt.turn,
    })),
    effects: world.effects.map((effect) => ({
      effect_id: effect.effect_id,
      invocation_id: effect.invocation_id,
      tool: effect.tool,
    })),
  });
}

function validateObservation(observation: CallerWorldObservation, plan: NormalizedPlan): CallerWorldObservation {
  assertOnlyKeys(observation, ["schema_version", "world_revision", "facts", "receipts", "effects"], "caller world observation");
  if (observation.schema_version !== 1) throw new Error("unsupported caller world observation schema");
  assertNonNegativeInteger(observation.world_revision, "caller world observation revision");
  assertPlainRecord(observation.facts, "caller world observation facts");
  for (const key of Object.keys(observation.facts)) {
    assertFlatFactId(key, `caller world observation fact ${key}`);
    if (!plan.observableWorldFacts.has(key)) {
      throw new Error(`caller world observation exposes non-allowlisted fact ${key}`);
    }
  }
  const toolNames = new Set(plan.scenario.tools.map((tool) => tool.name));
  observation.receipts.forEach((receipt, index) => {
    assertOnlyKeys(receipt, ["receipt_id", "invocation_id", "tool", "status", "committed", "turn"], `caller world receipt ${index}`);
    if (!toolNames.has(receipt.tool)) throw new Error(`caller world receipt ${index} exposes unknown tool ${receipt.tool}`);
    assertNonEmpty(receipt.receipt_id, `caller world receipt ${index}.receipt_id`);
    assertNonEmpty(receipt.invocation_id, `caller world receipt ${index}.invocation_id`);
    if (!["succeeded", "rejected", "failed_before_commit", "committed_after_error", "deduplicated"].includes(receipt.status)) {
      throw new Error(`caller world receipt ${index}.status is invalid`);
    }
    if (typeof receipt.committed !== "boolean") throw new Error(`caller world receipt ${index}.committed must be boolean`);
    assertNonNegativeInteger(receipt.turn, `caller world receipt ${index}.turn`);
  });
  observation.effects.forEach((effect, index) => {
    assertOnlyKeys(effect, ["effect_id", "invocation_id", "tool"], `caller world effect ${index}`);
    if (!toolNames.has(effect.tool)) throw new Error(`caller world effect ${index} exposes unknown tool ${effect.tool}`);
    assertNonEmpty(effect.effect_id, `caller world effect ${index}.effect_id`);
    assertNonEmpty(effect.invocation_id, `caller world effect ${index}.invocation_id`);
  });
  return asImmutable(observation);
}

function observationHash(observation: CallerWorldObservation): string {
  return sha256Hex(`${OBSERVATION_HASH_DOMAIN}${canonicalJson(observation)}`);
}

function predicatePassed(
  predicate: CallerSelectionPredicate,
  state: CallerSchedulerState,
  observation: CallerWorldObservation
): boolean {
  switch (predicate.kind) {
    case "world_fact_equals":
      return Object.prototype.hasOwnProperty.call(observation.facts, predicate.fact_key)
        && sameJson(observation.facts[predicate.fact_key], predicate.value);
    case "world_fact_exists":
      return Object.prototype.hasOwnProperty.call(observation.facts, predicate.fact_key);
    case "caller_fact_equals":
      return Boolean(state.caller_facts[predicate.fact_id])
        && sameJson(state.caller_facts[predicate.fact_id].value, predicate.value);
    case "caller_fact_revision_at_least":
      return (state.caller_facts[predicate.fact_id]?.revision ?? 0) >= predicate.revision;
    case "effect_count_at_least":
      return observation.effects.filter((effect) => effect.tool === predicate.tool).length >= predicate.count;
    case "receipt_count_at_least":
      return observation.receipts.filter((receipt) =>
        receipt.tool === predicate.tool
        && (predicate.status === undefined || receipt.status === predicate.status)
        && (predicate.committed === undefined || receipt.committed === predicate.committed)
      ).length >= predicate.count;
    case "turn_committed":
      return state.committed_turn_ids.includes(predicate.turn_id);
  }
}

function candidateFailureReasons(
  candidate: CallerStageCandidate,
  state: CallerSchedulerState,
  observation: CallerWorldObservation
): readonly string[] {
  return Object.freeze(candidate.when.flatMap((predicate, index) =>
    predicatePassed(predicate, state, observation) ? [] : [`${candidate.turn_id}.when[${index}]:${predicate.kind}`]
  ));
}

function assertStateIdentity(state: CallerSchedulerState, plan: NormalizedPlan): void {
  if (
    state.schema_version !== 1
    || state.run_id !== plan.runId
    || state.scenario_id !== plan.scenario.id
    || state.scenario_version !== plan.scenario.version
    || state.schedule_sha256 !== plan.scheduleHash
  ) throw new Error("caller scheduler state belongs to a different run or scenario");
  if (state.stage_index < 0 || state.stage_index > plan.stages.length) throw new Error("caller scheduler stage index is invalid");
  if (state.stage_index !== state.committed_turn_ids.length) throw new Error("caller scheduler stage and committed-turn counts diverge");
  if (new Set(state.committed_turn_ids).size !== state.committed_turn_ids.length) throw new Error("caller scheduler repeats a committed turn");
  if (new Set(state.fired_opportunity_ids).size !== state.fired_opportunity_ids.length) throw new Error("caller scheduler repeats a fired opportunity");
  if (!verifyEventChain(state.evidence).valid) throw new Error("caller scheduler evidence chain is invalid");
  const evidenceHashes = new Set(state.evidence.map((event) => event.event_hash));
  for (const [factId, fact] of Object.entries(state.caller_facts)) {
    if (!plan.factRules.has(factId) || fact.fact_id !== factId) throw new Error(`caller scheduler contains unallowlisted fact ${factId}`);
    if (!evidenceHashes.has(fact.evidence_hash)) throw new Error(`caller fact ${factId} is not bound to scheduler evidence`);
    assertPositiveInteger(fact.revision, `caller fact ${factId}.revision`);
  }
}

function appendEvidence(
  evidence: readonly BenchmarkEventEnvelope[],
  runId: string,
  observedAt: string,
  eventType: string,
  payload: ArtifactJsonValue
): BenchmarkEventEnvelope {
  if (evidence.length > 0 && Date.parse(observedAt) < Date.parse(evidence[evidence.length - 1].observed_at)) {
    throw new Error("caller scheduler evidence timestamps must be monotonic");
  }
  return evidence.length === 0
    ? startEventChain({ run_id: runId, observed_at: observedAt, event_type: eventType, payload })
    : appendEventEnvelope(evidence[evidence.length - 1], {
        observed_at: observedAt,
        event_type: eventType,
        payload,
      });
}

function triggerReceipt(
  trigger: Extract<OpportunityTrigger, { boundary: "after_receipt" }>,
  observation: CallerWorldObservation
): ObservableReceipt | null {
  const matching = observation.receipts.filter((receipt) =>
    receipt.tool === trigger.tool
    && (trigger.status === undefined || receipt.status === trigger.status)
    && (trigger.committed === undefined || receipt.committed === trigger.committed)
  );
  return matching[trigger.occurrence - 1] ?? null;
}

function materializeScheduledOpportunity(
  spec: CallerOpportunitySpec,
  observationSha256: string,
  sourceReceiptId?: string
): ScheduledCallerOpportunity {
  if (spec.kind === "reconnect") return asImmutable({
    id: spec.id,
    kind: spec.kind,
    trigger: spec.trigger,
    reconnect_mode: spec.reconnect_mode,
    observation_sha256: observationSha256,
  });
  if (spec.kind === "interruption") return asImmutable({
    id: spec.id,
    kind: spec.kind,
    trigger: spec.trigger,
    after_output_ms: spec.after_output_ms,
    reason: spec.reason,
    observation_sha256: observationSha256,
  });
  if (!sourceReceiptId) throw new Error(`delivery opportunity ${spec.id} has no source receipt`);
  return asImmutable({
    id: spec.id,
    kind: spec.kind,
    trigger: spec.trigger,
    delivery_mode: spec.delivery_mode,
    source_receipt_id: sourceReceiptId,
    observation_sha256: observationSha256,
  });
}

function dueBoundaryOpportunities(
  plan: NormalizedPlan,
  state: CallerSchedulerState,
  observation: CallerWorldObservation,
  boundary: "before_turn" | "after_turn",
  turnId: string
): readonly ScheduledCallerOpportunity[] {
  const fired = new Set(state.fired_opportunity_ids);
  const digest = observationHash(observation);
  return Object.freeze(plan.opportunities.flatMap((spec) =>
    fired.has(spec.id)
    || spec.trigger.boundary !== boundary
    || spec.trigger.turn_id !== turnId
      ? []
      : [materializeScheduledOpportunity(spec, digest)]
  ));
}

function opportunityEvidencePayload(
  opportunity: ScheduledCallerOpportunity,
  schedulerRevision: number
): ArtifactJsonValue {
  return asImmutable({
    schema_version: 1,
    opportunity,
    scheduler_revision: schedulerRevision,
  }) as unknown as ArtifactJsonValue;
}

function withScheduledOpportunities(
  input: Readonly<{
    state: CallerSchedulerState;
    opportunities: readonly ScheduledCallerOpportunity[];
    observedAt: string;
    schedulerRevision: number;
  }>
): Readonly<{ fired: readonly string[]; evidence: readonly BenchmarkEventEnvelope[]; appended: readonly BenchmarkEventEnvelope[] }> {
  if (input.opportunities.length === 0) return Object.freeze({
    fired: input.state.fired_opportunity_ids,
    evidence: input.state.evidence,
    appended: Object.freeze([]),
  });
  const fired = [...input.state.fired_opportunity_ids];
  const evidence = [...input.state.evidence];
  const appended: BenchmarkEventEnvelope[] = [];
  for (const opportunity of input.opportunities) {
    if (fired.includes(opportunity.id)) throw new Error(`opportunity ${opportunity.id} was already scheduled`);
    fired.push(opportunity.id);
    const event = appendEvidence(
      evidence,
      input.state.run_id,
      input.observedAt,
      "caller.opportunity_scheduled",
      opportunityEvidencePayload(opportunity, input.schedulerRevision)
    );
    evidence.push(event);
    appended.push(event);
  }
  return Object.freeze({
    fired: Object.freeze(fired),
    evidence: Object.freeze(evidence),
    appended: Object.freeze(appended),
  });
}

function createInitialState(plan: NormalizedPlan, createdAt: string): CallerSchedulerState {
  const initialized = startEventChain({
    run_id: plan.runId,
    observed_at: createdAt,
    event_type: "caller.scheduler_initialized",
    payload: asImmutable({
      schema_version: 1,
      scenario_id: plan.scenario.id,
      scenario_version: plan.scenario.version,
      schedule_sha256: plan.scheduleHash,
      stage_count: plan.stages.length,
      fact_allowlist: [...plan.factRules.values()].map((rule) => ({
        fact_id: rule.fact_id,
        world_fact_key: rule.world_fact_key,
      })),
      observable_world_fact_keys: [...plan.observableWorldFacts].sort(),
      audio_fixture_set_id: plan.audio.fixture_set_id,
      audio_fixture_manifest_sha256: plan.audio.fixture_manifest_sha256,
    }) as unknown as ArtifactJsonValue,
  });
  return asImmutable({
    schema_version: 1,
    run_id: plan.runId,
    scenario_id: plan.scenario.id,
    scenario_version: plan.scenario.version,
    schedule_sha256: plan.scheduleHash,
    scheduler_revision: 0,
    stage_index: 0,
    pending_turn: null,
    committed_turn_ids: [],
    caller_facts: {},
    fired_opportunity_ids: [],
    evidence: [initialized],
  });
}

function turnById(scenario: BenchmarkScenario, turnId: string): CallerTurn {
  const turn = scenario.caller.turns.find((candidate) => candidate.id === turnId);
  if (!turn) throw new Error(`unknown caller turn ${turnId}`);
  return turn;
}

function selectNext(
  plan: NormalizedPlan,
  input: Readonly<{
    state: CallerSchedulerState;
    observation: CallerWorldObservation;
    observed_at: string;
  }>
): SelectCallerTurnResult {
  assertOnlyKeys(input, ["state", "observation", "observed_at"], "selectNext input");
  assertStateIdentity(input.state, plan);
  if (input.state.pending_turn) throw new Error(`caller turn ${input.state.pending_turn.turn_id} is pending commit`);
  const observation = validateObservation(input.observation, plan);
  if (input.state.stage_index >= plan.stages.length) return asImmutable({ status: "complete", state: input.state });
  const stage = plan.stages[input.state.stage_index];
  const evaluations = stage.candidates.map((candidate) => ({
    candidate,
    unmet: candidateFailureReasons(candidate, input.state, observation),
  }));
  const eligible = evaluations.filter((evaluation) => evaluation.unmet.length === 0);
  if (eligible.length === 0) return asImmutable({
    status: "blocked",
    state: input.state,
    stage_id: stage.id,
    unmet: evaluations.flatMap((evaluation) => evaluation.unmet),
  });
  if (eligible.length > 1) {
    throw new Error(`caller stage ${stage.id} is nondeterministic: ${eligible.map(({ candidate }) => candidate.turn_id).join(", ")}`);
  }
  const candidate = eligible[0].candidate;
  const turn = turnById(plan.scenario, candidate.turn_id);
  const audio = plan.audio.turns[candidate.audio_turn_id];
  const nextRevision = input.state.scheduler_revision + 1;
  const digest = observationHash(observation);
  const selectionId = `caller-selection:${plan.runId}:${nextRevision}:${candidate.turn_id}`;
  const pending: PendingCallerTurn = asImmutable({
    selection_id: selectionId,
    stage_id: stage.id,
    turn_id: candidate.turn_id,
    audio_turn_id: candidate.audio_turn_id,
    selected_at_world_revision: observation.world_revision,
    observation_sha256: digest,
  });
  const selection: CallerTurnSelection = asImmutable({
    selection_id: selectionId,
    stage_id: stage.id,
    turn_id: candidate.turn_id,
    utterance: turn.utterance,
    audio,
    observation_sha256: digest,
  });
  const selectionEvent = appendEvidence(
    input.state.evidence,
    plan.runId,
    input.observed_at,
    "caller.turn_selected",
    asImmutable({
      schema_version: 1,
      scheduler_revision: nextRevision,
      stage_id: stage.id,
      turn_id: candidate.turn_id,
      audio_turn_id: candidate.audio_turn_id,
      audio_sha256: audio.pcm_sha256,
      observation_sha256: digest,
      world_revision: observation.world_revision,
    }) as unknown as ArtifactJsonValue
  );
  const intermediate: CallerSchedulerState = asImmutable({
    ...input.state,
    scheduler_revision: nextRevision,
    pending_turn: pending,
    evidence: [...input.state.evidence, selectionEvent],
  });
  const opportunities = dueBoundaryOpportunities(plan, intermediate, observation, "before_turn", candidate.turn_id);
  const scheduled = withScheduledOpportunities({
    state: intermediate,
    opportunities,
    observedAt: input.observed_at,
    schedulerRevision: nextRevision,
  });
  const state = asImmutable({
    ...intermediate,
    fired_opportunity_ids: scheduled.fired,
    evidence: scheduled.evidence,
  });
  return Object.freeze({
    status: "selected",
    state,
    selection,
    opportunities,
    evidence: Object.freeze([selectionEvent, ...scheduled.appended]),
  });
}

type PreparedFactUpdate = Readonly<{
  rule: CallerFactAllowlistRule;
  update: CallerTurn["fact_updates"][number];
  current: CallerFactState | null;
  factRevision: number;
  type: TrustedCallerWorldEvent["type"];
}>;

function prepareFactUpdates(
  plan: NormalizedPlan,
  state: CallerSchedulerState,
  turn: CallerTurn
): readonly PreparedFactUpdate[] {
  return Object.freeze(turn.fact_updates.map((update) => {
    const rule = plan.factRules.get(update.fact);
    if (!rule) throw new Error(`caller turn ${turn.id} updates unallowlisted fact ${update.fact}`);
    assertValueContract(update.value, rule.contract, `caller turn ${turn.id} fact ${update.fact}`);
    const current = state.caller_facts[update.fact] ?? null;
    const hasSupersedes = Object.prototype.hasOwnProperty.call(update, "supersedes");
    if (!current) {
      if (hasSupersedes) throw new Error(`caller fact ${update.fact} cannot supersede before its first assertion`);
      return Object.freeze({ rule, update, current, factRevision: 1, type: "caller.world_fact_asserted" as const });
    }
    if (!hasSupersedes) {
      throw new Error(`caller fact ${update.fact} revision ${current.revision + 1} requires an explicit supersedes value`);
    }
    if (!sameJson(update.supersedes, current.value)) {
      throw new Error(`caller fact ${update.fact} supersedes value does not match revision ${current.revision}`);
    }
    if (sameJson(update.value, current.value)) {
      throw new Error(`caller fact ${update.fact} cannot create a no-op superseding revision`);
    }
    return Object.freeze({
      rule,
      update,
      current,
      factRevision: current.revision + 1,
      type: "caller.world_fact_superseded" as const,
    });
  }));
}

function commitTurn(
  plan: NormalizedPlan,
  input: Readonly<{
    state: CallerSchedulerState;
    selection_id: string;
    observation: CallerWorldObservation;
    observed_at: string;
  }>
): CommitCallerTurnResult {
  assertOnlyKeys(input, ["state", "selection_id", "observation", "observed_at"], "commitTurn input");
  assertStateIdentity(input.state, plan);
  const pending = input.state.pending_turn;
  if (!pending) throw new Error("no caller turn is pending commit");
  if (pending.selection_id !== input.selection_id) throw new Error("caller selection id does not match the pending turn");
  const observation = validateObservation(input.observation, plan);
  const turn = turnById(plan.scenario, pending.turn_id);
  const prepared = prepareFactUpdates(plan, input.state, turn);
  const nextRevision = input.state.scheduler_revision + 1;
  const callerFacts: Record<string, CallerFactState> = structuredClone(input.state.caller_facts);
  const evidence = [...input.state.evidence];
  const appended: BenchmarkEventEnvelope[] = [];
  const worldEvents: TrustedCallerWorldEvent[] = [];

  for (const item of prepared) {
    const base = {
      schema_version: 1 as const,
      type: item.type,
      authority: "caller_reported" as const,
      trusted: true as const,
      fact_id: item.rule.fact_id,
      world_fact_key: item.rule.world_fact_key,
      value: structuredClone(item.update.value),
      revision: item.factRevision,
      previous_revision: item.current?.revision ?? 0,
      source_turn_id: turn.id,
      turn_boundary: input.state.stage_index + 1,
      scheduler_revision: nextRevision,
    };
    const worldEvent: TrustedCallerWorldEvent = item.current
      ? asImmutable({ ...base, supersedes: structuredClone(item.update.supersedes!) })
      : asImmutable(base);
    const event = appendEvidence(
      evidence,
      plan.runId,
      input.observed_at,
      worldEvent.type,
      worldEvent as unknown as ArtifactJsonValue
    );
    evidence.push(event);
    appended.push(event);
    worldEvents.push(worldEvent);
    callerFacts[item.rule.fact_id] = asImmutable({
      fact_id: item.rule.fact_id,
      world_fact_key: item.rule.world_fact_key,
      value: structuredClone(item.update.value),
      revision: item.factRevision,
      source_turn_id: turn.id,
      evidence_hash: event.event_hash,
    });
  }

  const committed = appendEvidence(
    evidence,
    plan.runId,
    input.observed_at,
    "caller.turn_committed",
    asImmutable({
      schema_version: 1,
      scheduler_revision: nextRevision,
      stage_id: pending.stage_id,
      turn_id: pending.turn_id,
      selection_id: pending.selection_id,
      fact_event_count: worldEvents.length,
      selected_observation_sha256: pending.observation_sha256,
      commit_observation_sha256: observationHash(observation),
      selected_world_revision: pending.selected_at_world_revision,
      committed_world_revision: observation.world_revision,
    }) as unknown as ArtifactJsonValue
  );
  evidence.push(committed);
  appended.push(committed);

  const intermediate: CallerSchedulerState = asImmutable({
    ...input.state,
    scheduler_revision: nextRevision,
    stage_index: input.state.stage_index + 1,
    pending_turn: null,
    committed_turn_ids: [...input.state.committed_turn_ids, pending.turn_id],
    caller_facts: callerFacts,
    evidence,
  });
  const opportunities = dueBoundaryOpportunities(plan, intermediate, observation, "after_turn", pending.turn_id);
  const scheduled = withScheduledOpportunities({
    state: intermediate,
    opportunities,
    observedAt: input.observed_at,
    schedulerRevision: nextRevision,
  });
  const state = asImmutable({
    ...intermediate,
    fired_opportunity_ids: scheduled.fired,
    evidence: scheduled.evidence,
  });
  return Object.freeze({
    state,
    world_events: Object.freeze(worldEvents),
    opportunities,
    evidence: Object.freeze([...appended, ...scheduled.appended]),
  });
}

function pollOpportunities(
  plan: NormalizedPlan,
  input: Readonly<{
    state: CallerSchedulerState;
    observation: CallerWorldObservation;
    observed_at: string;
  }>
): PollCallerOpportunitiesResult {
  assertOnlyKeys(input, ["state", "observation", "observed_at"], "pollOpportunities input");
  assertStateIdentity(input.state, plan);
  const observation = validateObservation(input.observation, plan);
  const fired = new Set(input.state.fired_opportunity_ids);
  const digest = observationHash(observation);
  const opportunities = Object.freeze(plan.opportunities.flatMap((spec) => {
    if (fired.has(spec.id) || spec.trigger.boundary !== "after_receipt") return [];
    const receipt = triggerReceipt(spec.trigger, observation);
    return receipt ? [materializeScheduledOpportunity(spec, digest, receipt.receipt_id)] : [];
  }));
  if (opportunities.length === 0) return Object.freeze({
    state: input.state,
    opportunities,
    evidence: Object.freeze([]),
  });
  const nextRevision = input.state.scheduler_revision + 1;
  const scheduled = withScheduledOpportunities({
    state: input.state,
    opportunities,
    observedAt: input.observed_at,
    schedulerRevision: nextRevision,
  });
  const state = asImmutable({
    ...input.state,
    scheduler_revision: nextRevision,
    fired_opportunity_ids: scheduled.fired,
    evidence: scheduled.evidence,
  });
  return Object.freeze({ state, opportunities, evidence: scheduled.appended });
}

/**
 * Construct an immutable, condition-blind caller/world scheduler. Its public
 * transition methods accept no provider, model, arm, prompt, transcript, or
 * judge output, making accidental treatment-specific caller behavior harder.
 */
export function createDeterministicCallerWorldScheduler(
  input: CallerWorldSchedulePlan
): DeterministicCallerWorldScheduler {
  const plan = normalizePlan(input);
  const initialState = createInitialState(plan, input.created_at);
  return Object.freeze({
    scenario: plan.scenario,
    initialState,
    selectNext: (transition) => selectNext(plan, transition),
    commitTurn: (transition) => commitTurn(plan, transition),
    pollOpportunities: (transition) => pollOpportunities(plan, transition),
  });
}

function semanticIntent(call: CapabilityGatewayCall): ArtifactJsonValue {
  return asImmutable({ tool_name: call.tool_name, arguments: call.arguments }) as unknown as ArtifactJsonValue;
}

function deliveryHash(
  callId: string,
  call: CapabilityGatewayCall,
  hostAuthority: RecordedGatewayCall["host_authority"]
): string {
  return sha256Hex(`${DELIVERY_HASH_DOMAIN}${canonicalJson({
    call_id: callId,
    call,
    host_authority_sha256: sha256Hex(`${DELIVERY_HASH_DOMAIN}${canonicalJson(hostAuthority)}`),
  })}`);
}

/**
 * Materialize three deliberately non-overlapping duplicate/replay stimuli.
 * The output is ready for a realtime fake/provider adapter to inject.
 */
export function materializeGatewayDelivery(input: Readonly<{
  opportunity: ScheduledGatewayDeliveryOpportunity;
  original: RecordedGatewayCall;
  new_provider_call_id?: string;
  current_host_authority?: RecordedGatewayCall["host_authority"];
}>): MaterializedGatewayDelivery {
  assertOnlyKeys(input, [
    "opportunity",
    "original",
    "new_provider_call_id",
    "current_host_authority",
  ], "materializeGatewayDelivery input");
  assertOnlyKeys(input.opportunity, [
    "id",
    "kind",
    "trigger",
    "delivery_mode",
    "source_receipt_id",
    "observation_sha256",
  ], "materializeGatewayDelivery opportunity");
  if (input.opportunity.kind !== "gateway_delivery") throw new Error("delivery opportunity kind must be gateway_delivery");
  assertOnlyKeys(input.original, ["receipt_id", "provider_call_id", "call", "host_authority"], "original gateway call");
  assertOnlyKeys(input.original.host_authority, ["capability_epoch", "capability_grant"], "original host authority");
  if (input.original.receipt_id !== input.opportunity.source_receipt_id) {
    throw new Error("original gateway call is not bound to the opportunity source receipt");
  }
  const originalCall = CapabilityGatewayCallSchema.parse(input.original.call);
  assertNonEmpty(input.original.receipt_id, "original receipt_id", 512);
  assertNonEmpty(input.original.provider_call_id, "original provider_call_id", 512);
  assertNonNegativeInteger(input.original.host_authority.capability_epoch, "original capability_epoch");
  assertNonEmpty(input.original.host_authority.capability_grant, "original capability_grant", 8192);
  const sourceIntent = semanticIntent(originalCall);

  let emittedProviderCallId: string;
  let emittedEpoch: number;
  let observedCurrentEpoch: number;
  let call: CapabilityGatewayCall;
  let hostAuthority: RecordedGatewayCall["host_authority"];
  let grantRelation: MaterializedGatewayDelivery["relation"]["grant"];

  if (input.opportunity.delivery_mode === "exact_same_call_id") {
    if (
      input.new_provider_call_id !== undefined
      || input.current_host_authority !== undefined
    ) throw new Error("exact same-call-ID replay does not accept a new ID or current grant");
    emittedProviderCallId = input.original.provider_call_id;
    emittedEpoch = input.original.host_authority.capability_epoch;
    observedCurrentEpoch = input.original.host_authority.capability_epoch;
    call = originalCall;
    hostAuthority = input.original.host_authority;
    grantRelation = "exact_original";
  } else {
    assertNonEmpty(input.new_provider_call_id, "new_provider_call_id", 512);
    if (input.new_provider_call_id === input.original.provider_call_id) {
      throw new Error(`${input.opportunity.delivery_mode} requires a new provider call ID`);
    }
    if (!input.current_host_authority) throw new Error("current_host_authority is required");
    assertOnlyKeys(input.current_host_authority, ["capability_epoch", "capability_grant"], "current host authority");
    assertNonEmpty(input.current_host_authority.capability_grant, "current capability_grant", 8192);
    assertNonNegativeInteger(input.current_host_authority.capability_epoch, "current capability_epoch");
    if (input.current_host_authority.capability_epoch < input.original.host_authority.capability_epoch) {
      throw new Error("current capability epoch cannot precede the original epoch");
    }
    emittedProviderCallId = input.new_provider_call_id;
    observedCurrentEpoch = input.current_host_authority.capability_epoch;
    if (input.opportunity.delivery_mode === "new_id_semantic_duplicate") {
      emittedEpoch = input.current_host_authority.capability_epoch;
      call = originalCall;
      hostAuthority = input.current_host_authority;
      grantRelation = "current";
    } else {
      if (
        input.current_host_authority.capability_epoch <= input.original.host_authority.capability_epoch
        || input.current_host_authority.capability_grant === input.original.host_authority.capability_grant
      ) throw new Error("stale-grant replay requires an observably newer, different current grant");
      emittedEpoch = input.original.host_authority.capability_epoch;
      call = originalCall;
      hostAuthority = input.original.host_authority;
      grantRelation = "stale_original";
    }
  }

  const emittedIntent = semanticIntent(call);
  if (!sameJson(sourceIntent, emittedIntent)) throw new Error("delivery replay changed semantic action or arguments");
  const evidence: MaterializedGatewayDelivery["evidence"] = asImmutable({
    schema_version: 1 as const,
    type: "gateway.delivery_materialized",
    opportunity_id: input.opportunity.id,
    delivery_mode: input.opportunity.delivery_mode,
    source_provider_call_id: input.original.provider_call_id,
    emitted_provider_call_id: emittedProviderCallId,
    source_call_sha256: deliveryHash(input.original.provider_call_id, originalCall, input.original.host_authority),
    emitted_call_sha256: deliveryHash(emittedProviderCallId, call, hostAuthority),
    semantic_intent_sha256: sha256Hex(`${DELIVERY_HASH_DOMAIN}${canonicalJson(sourceIntent)}`),
    source_host_authority_sha256: sha256Hex(`${DELIVERY_HASH_DOMAIN}${canonicalJson(input.original.host_authority)}`),
    emitted_host_authority_sha256: sha256Hex(`${DELIVERY_HASH_DOMAIN}${canonicalJson(hostAuthority)}`),
    grant_relation: grantRelation,
  });
  return asImmutable({
    opportunity_id: input.opportunity.id,
    delivery_mode: input.opportunity.delivery_mode,
    source_provider_call_id: input.original.provider_call_id,
    emitted_provider_call_id: emittedProviderCallId,
    source_capability_epoch: input.original.host_authority.capability_epoch,
    emitted_capability_epoch: emittedEpoch,
    observed_current_capability_epoch: observedCurrentEpoch,
    call,
    host_authority: hostAuthority,
    relation: {
      same_call_id: emittedProviderCallId === input.original.provider_call_id,
      same_semantic_intent: true,
      grant: grantRelation,
    },
    evidence,
  });
}
