import { canonicalJson, sha256Hex } from "./artifacts";
import { createLc4PowerPlanArtifact } from "./lc4-power-plan";
import type { Lc4GeneratedHeldoutTemplate } from "./lc4-heldout-commitment";
import {
  assertLc4GenericScenarioPayload,
  type Lc4GenericScenarioPayload,
} from "./lc4-heldout-generator";
import {
  LC4_PROVIDER_PROFILE_MANIFEST,
  assertLc4ProviderProfileManifest,
} from "./lc4-provider-profiles";
import type { LiveStsProvider } from "./live-sts-development-experiment";

export const LC4_RUNNER_PROTOCOL = "HACC-LC4-v1" as const;
export const LC4_RUNNER_FOUNDATION_VERSION = "LC4-PRODUCTION-RUNNER-FOUNDATION-v1" as const;
export const LC4_EPISODES = 144 as const;
export const LC4_PAIRS = 72 as const;
export const LC4_TEMPLATES = 24 as const;
export const LC4_OPPORTUNITIES_PER_EPISODE = 60 as const;
export const LC4_SEGMENTS_PER_EPISODE = 3 as const;
export const LC4_OPPORTUNITIES_PER_SEGMENT = 20 as const;
export const LC4_SCHEDULING_CEILING_MICRO_USD = 900_000_000 as const;

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const SCHEDULE_DOMAIN = "harshas-amazing-call-center/lc4-production-schedule-shape/v1\n";
const EPISODE_DOMAIN = "harshas-amazing-call-center/lc4-production-episode-manifest/v1\n";
const QUALIFICATION_DOMAIN = "harshas-amazing-call-center/lc4-production-qualification-gate/v1\n";
const GENERATOR_JOIN_CONTRACT_DOMAIN = "harshas-amazing-call-center/lc4-generator-schedule-join-contract/v1\n";
const GENERATOR_JOIN_DOMAIN = "harshas-amazing-call-center/lc4-generator-schedule-join/v1\n";

export type Lc4Arm = "native" | "hacc";

export type Lc4SegmentShape = Readonly<{
  ordinal: 1 | 2 | 3;
  act: "establish" | "interleave" | "reconcile";
  opportunity_start: number;
  opportunity_end: number;
  opportunity_count: 20;
  provider_session_rotation_required_after: boolean;
}>;

export type Lc4ProviderExecutionProfile = Readonly<{
  provider: LiveStsProvider;
  model: string;
  voice: string;
  input_sample_rate_hz: number;
  output_sample_rate_hz: number;
  turn_boundary: string;
  context_authority: string;
  provider_profile_sha256: string;
}>;

export type Lc4PairShape = Readonly<{
  ordinal: number;
  pair_id: string;
  template_id: string;
  family: string;
  structural_variant: string;
  tts_voice_slot: string;
  provider: LiveStsProvider;
  arm_order: readonly [Lc4Arm, Lc4Arm];
  provider_execution_position: number;
  provider_profile: Lc4ProviderExecutionProfile;
}>;

export type Lc4EpisodeShape = Readonly<{
  ordinal: number;
  pair_ordinal: number;
  pair_id: string;
  run_id: string;
  template_id: string;
  family: string;
  structural_variant: string;
  tts_voice_slot: string;
  provider: LiveStsProvider;
  arm: Lc4Arm;
  arm_position: 1 | 2;
  provider_execution_position: number;
  provider_profile: Lc4ProviderExecutionProfile;
  segments: readonly Lc4SegmentShape[];
  opportunity_count: 60;
  retry_policy: "never_retry_opened_or_consumed_run_id";
  maximum_reservation_micro_usd: number;
}>;

export type Lc4ProductionScheduleShape = Readonly<{
  schema_version: 1;
  protocol_id: typeof LC4_RUNNER_PROTOCOL;
  runner_foundation_version: typeof LC4_RUNNER_FOUNDATION_VERSION;
  status: "shape_frozen_provider_execution_forbidden";
  provider_calls_authorized: false;
  heldout_plaintext_required: false;
  templates: 24;
  pairs: 72;
  episodes: 144;
  opportunities_per_episode: 60;
  scheduled_opportunities: 8_640;
  logical_segments_per_episode: 3;
  profile_manifest_sha256: string;
  power_plan_sha256: string;
  generator_join_contract_sha256: string;
  scheduling_ceiling_micro_usd: 900_000_000;
  maximum_scheduled_reservations_micro_usd: number;
  pair_shapes: readonly Lc4PairShape[];
  episode_shapes: readonly Lc4EpisodeShape[];
  schedule_sha256: string;
}>;

const SEGMENTS: readonly Lc4SegmentShape[] = Object.freeze([
  Object.freeze({
    ordinal: 1 as const,
    act: "establish" as const,
    opportunity_start: 1,
    opportunity_end: 20,
    opportunity_count: 20 as const,
    provider_session_rotation_required_after: true,
  }),
  Object.freeze({
    ordinal: 2 as const,
    act: "interleave" as const,
    opportunity_start: 21,
    opportunity_end: 40,
    opportunity_count: 20 as const,
    provider_session_rotation_required_after: true,
  }),
  Object.freeze({
    ordinal: 3 as const,
    act: "reconcile" as const,
    opportunity_start: 41,
    opportunity_end: 60,
    opportunity_count: 20 as const,
    provider_session_rotation_required_after: false,
  }),
]);

/** Rounded-up per-episode shares of the frozen 150% provider stress envelope. */
export const LC4_PROVIDER_EPISODE_RESERVATION_MICRO_USD = Object.freeze({
  openai: 4_686_714,
  gemini: 7_517_948,
  xai: 2_096_258,
} satisfies Record<LiveStsProvider, number>);

function profileFor(provider: LiveStsProvider): Lc4ProviderExecutionProfile {
  assertLc4ProviderProfileManifest(LC4_PROVIDER_PROFILE_MANIFEST);
  const profile = LC4_PROVIDER_PROFILE_MANIFEST.providers[provider];
  return Object.freeze({
    provider,
    model: profile.model,
    voice: profile.voice,
    input_sample_rate_hz: profile.input_sample_rate_hz,
    output_sample_rate_hz: profile.output_sample_rate_hz,
    turn_boundary: profile.turn_boundary,
    context_authority: profile.context_delivery.authority,
    provider_profile_sha256: sha256Hex(`hacc-lc4/provider-execution-profile/v2\n${canonicalJson(profile)}`),
  });
}

function scheduleBody() {
  const power = createLc4PowerPlanArtifact();
  const generatorJoinContract = lc4GeneratorJoinContract(power);
  const assignments = [...power.randomization.assignments].sort((left, right) => {
    const template = left.template_id.localeCompare(right.template_id);
    if (template !== 0) return template;
    const leftPosition = left.provider_execution_order.indexOf(left.provider);
    const rightPosition = right.provider_execution_order.indexOf(right.provider);
    return leftPosition - rightPosition;
  });
  const pairShapes: Lc4PairShape[] = assignments.map((assignment, index) => Object.freeze({
    ordinal: index + 1,
    pair_id: assignment.pair_id,
    template_id: assignment.template_id,
    family: assignment.family,
    structural_variant: assignment.structural_variant,
    tts_voice_slot: assignment.tts_voice_slot,
    provider: assignment.provider,
    arm_order: assignment.arm_order,
    provider_execution_position: assignment.provider_execution_order.indexOf(assignment.provider) + 1,
    provider_profile: profileFor(assignment.provider),
  }));
  let episodeOrdinal = 0;
  const episodeShapes: Lc4EpisodeShape[] = pairShapes.flatMap((pair) => pair.arm_order.map((arm, armIndex) => Object.freeze({
    ordinal: ++episodeOrdinal,
    pair_ordinal: pair.ordinal,
    pair_id: pair.pair_id,
    run_id: `${pair.pair_id}-${arm}`,
    template_id: pair.template_id,
    family: pair.family,
    structural_variant: pair.structural_variant,
    tts_voice_slot: pair.tts_voice_slot,
    provider: pair.provider,
    arm,
    arm_position: (armIndex + 1) as 1 | 2,
    provider_execution_position: pair.provider_execution_position,
    provider_profile: pair.provider_profile,
    segments: SEGMENTS,
    opportunity_count: 60 as const,
    retry_policy: "never_retry_opened_or_consumed_run_id" as const,
    maximum_reservation_micro_usd: LC4_PROVIDER_EPISODE_RESERVATION_MICRO_USD[pair.provider],
  })));
  const maximumReservations = episodeShapes.reduce((total, episode) => total + episode.maximum_reservation_micro_usd, 0);
  if (maximumReservations > LC4_SCHEDULING_CEILING_MICRO_USD) {
    throw new Error("LC4 episode reservations exceed the frozen scheduling ceiling");
  }
  return Object.freeze({
    schema_version: 1 as const,
    protocol_id: LC4_RUNNER_PROTOCOL,
    runner_foundation_version: LC4_RUNNER_FOUNDATION_VERSION,
    status: "shape_frozen_provider_execution_forbidden" as const,
    provider_calls_authorized: false as const,
    heldout_plaintext_required: false as const,
    templates: LC4_TEMPLATES,
    pairs: LC4_PAIRS,
    episodes: LC4_EPISODES,
    opportunities_per_episode: LC4_OPPORTUNITIES_PER_EPISODE,
    scheduled_opportunities: 8_640 as const,
    logical_segments_per_episode: LC4_SEGMENTS_PER_EPISODE,
    profile_manifest_sha256: LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
    power_plan_sha256: power.artifact_sha256,
    generator_join_contract_sha256: generatorJoinContract.contract_sha256,
    scheduling_ceiling_micro_usd: LC4_SCHEDULING_CEILING_MICRO_USD,
    maximum_scheduled_reservations_micro_usd: maximumReservations,
    pair_shapes: Object.freeze(pairShapes),
    episode_shapes: Object.freeze(episodeShapes),
  });
}

type Lc4PowerPlan = ReturnType<typeof createLc4PowerPlanArtifact>;

type Lc4ExpectedTemplateVocabulary = Readonly<{
  template_id: string;
  family_slot: number;
  structural_variant_slot: number;
  family: string;
  structural_variant: string;
  tts_voice_slot: string;
  pair_ids: readonly string[];
}>;

function expectedTemplateVocabulary(power: Lc4PowerPlan): readonly Lc4ExpectedTemplateVocabulary[] {
  const byTemplate = new Map<string, Lc4ExpectedTemplateVocabulary>();
  for (const assignment of power.randomization.assignments) {
    const familySlot = power.schedule.families.indexOf(assignment.family) + 1;
    const variantSlot = power.schedule.structural_variants.indexOf(assignment.structural_variant) + 1;
    if (familySlot < 1 || variantSlot < 1) throw new Error("LC4 power assignment uses vocabulary outside its frozen schedule");
    const canonicalTemplateId = `lc4-template-${String((familySlot - 1) * 4 + variantSlot).padStart(2, "0")}`;
    if (assignment.template_id !== canonicalTemplateId) throw new Error("LC4 power-plan template ID differs from its family/variant slot");
    const existing = byTemplate.get(assignment.template_id);
    if (!existing) {
      byTemplate.set(assignment.template_id, Object.freeze({
        template_id: assignment.template_id,
        family_slot: familySlot,
        structural_variant_slot: variantSlot,
        family: assignment.family,
        structural_variant: assignment.structural_variant,
        tts_voice_slot: assignment.tts_voice_slot,
        pair_ids: Object.freeze([assignment.pair_id]),
      }));
      continue;
    }
    if (
      existing.family_slot !== familySlot
      || existing.structural_variant_slot !== variantSlot
      || existing.family !== assignment.family
      || existing.structural_variant !== assignment.structural_variant
      || existing.tts_voice_slot !== assignment.tts_voice_slot
      || existing.pair_ids.includes(assignment.pair_id)
    ) throw new Error("LC4 power-plan provider assignments disagree on template vocabulary");
    byTemplate.set(assignment.template_id, Object.freeze({
      ...existing,
      pair_ids: Object.freeze([...existing.pair_ids, assignment.pair_id]),
    }));
  }
  const expected = [...byTemplate.values()]
    .map((entry) => Object.freeze({ ...entry, pair_ids: Object.freeze([...entry.pair_ids].sort()) }))
    .sort((left, right) => left.template_id.localeCompare(right.template_id));
  if (expected.length !== 24 || expected.some((entry) => entry.pair_ids.length !== 3)) {
    throw new Error("LC4 power plan does not define an exact 24-template/three-provider vocabulary");
  }
  return Object.freeze(expected);
}

function lc4GeneratorJoinContract(power: Lc4PowerPlan) {
  const body = Object.freeze({
    schema_version: 1 as const,
    protocol_id: LC4_RUNNER_PROTOCOL,
    power_plan_sha256: power.artifact_sha256,
    expected_templates: expectedTemplateVocabulary(power),
  });
  return Object.freeze({
    ...body,
    contract_sha256: sha256Hex(`${GENERATOR_JOIN_CONTRACT_DOMAIN}${canonicalJson(body)}`),
  });
}

export type Lc4HeldoutScheduleJoin = Readonly<{
  schema_version: 1;
  protocol_id: typeof LC4_RUNNER_PROTOCOL;
  power_plan_sha256: string;
  join_contract_sha256: string;
  template_count: 24;
  bindings: readonly Readonly<{
    template_id: string;
    family_slot: number;
    structural_variant_slot: number;
    family: string;
    structural_variant: string;
    tts_voice_slot: string;
    payload_content_sha256: string;
    canonical_caller_source_manifest_sha256: string;
    canonical_stage_manifest_sha256: string;
    pair_ids: readonly string[];
    binding_sha256: string;
  }>[];
  join_sha256: string;
}>;

/**
 * Join a custody-supplied generated corpus to the independently committed
 * power-plan allocation. The function neither generates nor unseals a corpus;
 * it accepts an already-authorized typed boundary and fails on every missing,
 * duplicate, extra, renamed, re-slotted, or semantically drifted template.
 */
export function joinLc4HeldoutTemplatesToSchedule(
  templates: readonly Lc4GeneratedHeldoutTemplate[],
): Lc4HeldoutScheduleJoin {
  const power = createLc4PowerPlanArtifact();
  const contract = lc4GeneratorJoinContract(power);
  if (templates.length !== 24) throw new Error("LC4 held-out schedule join requires exactly 24 templates");
  const byId = new Map<string, Lc4GeneratedHeldoutTemplate>();
  for (const template of templates) {
    if (byId.has(template.template_id)) throw new Error(`LC4 held-out schedule join contains duplicate template ${template.template_id}`);
    byId.set(template.template_id, template);
  }
  const expectedIds = contract.expected_templates.map((template) => template.template_id);
  const actualIds = [...byId.keys()].sort();
  if (canonicalJson(actualIds) !== canonicalJson(expectedIds)) {
    throw new Error("LC4 held-out generator template IDs are not an exact bijection with the power plan");
  }
  const bindings = contract.expected_templates.map((expected) => {
    const generated = byId.get(expected.template_id)!;
    assertLc4GenericScenarioPayload(generated.payload);
    const payload: Lc4GenericScenarioPayload = generated.payload;
    if (
      generated.family_slot !== expected.family_slot
      || generated.structural_variant_slot !== expected.structural_variant_slot
      || payload.template_id !== expected.template_id
      || payload.tts_voice_slot !== expected.tts_voice_slot
      || payload.family !== expected.family
      || payload.structural_variant !== expected.structural_variant
    ) {
      throw new Error(`LC4 held-out generator vocabulary drifted for ${expected.template_id}`);
    }
    const body = Object.freeze({
      template_id: expected.template_id,
      family_slot: expected.family_slot,
      structural_variant_slot: expected.structural_variant_slot,
      family: expected.family,
      structural_variant: expected.structural_variant,
      tts_voice_slot: expected.tts_voice_slot,
      payload_content_sha256: payload.content_sha256,
      canonical_caller_source_manifest_sha256: sha256Hex(`hacc-lc4/canonical-caller-source-manifest/v1\n${canonicalJson(
        payload.opportunities.map((opportunity) => ({
          opportunity_id: opportunity.id,
          opportunity_index: opportunity.index,
          act: opportunity.act,
          goal_id: opportunity.goal_id,
          stage_id: opportunity.stage_id,
          source_id: opportunity.canonical_caller_utterance.id,
          source_text_sha256: opportunity.canonical_caller_utterance.source_text_sha256,
          fact_bindings: opportunity.canonical_caller_utterance.fact_bindings.map((binding) => ({
            fact_key: binding.fact_key,
            fact_id: binding.fact_id,
            fact_version: binding.fact_version,
            binding_role: binding.binding_role,
            expected_value_sha256: binding.expected_value_sha256,
          })),
          registrations: opportunity.registrations,
        })),
      )}`),
      canonical_stage_manifest_sha256: sha256Hex(`hacc-lc4/canonical-stage-manifest/v1\n${canonicalJson({
        opportunities: payload.opportunities.map((opportunity) => ({
          opportunity_id: opportunity.id,
          index: opportunity.index,
          stage_id: opportunity.stage_id,
        })),
        checkpoints: payload.flow_checkpoints.map((checkpoint) => ({
          checkpoint_id: checkpoint.id,
          opportunity: checkpoint.opportunity,
          goal_id: checkpoint.goal_id,
        })),
        blockers: payload.normative_blockers.map((blocker) => ({
          stage_id: blocker.stage_id,
          deadline_opportunity: blocker.deadline_opportunity,
        })),
      })}`),
      pair_ids: expected.pair_ids,
    });
    return Object.freeze({
      ...body,
      binding_sha256: sha256Hex(`hacc-lc4/generator-schedule-template-binding/v1\n${canonicalJson(body)}`),
    });
  });
  const body = Object.freeze({
    schema_version: 1 as const,
    protocol_id: LC4_RUNNER_PROTOCOL,
    power_plan_sha256: power.artifact_sha256,
    join_contract_sha256: contract.contract_sha256,
    template_count: 24 as const,
    bindings: Object.freeze(bindings),
  });
  return deepFreeze({ ...body, join_sha256: sha256Hex(`${GENERATOR_JOIN_DOMAIN}${canonicalJson(body)}`) });
}

export function compileLc4ProductionScheduleShape(): Lc4ProductionScheduleShape {
  const body = scheduleBody();
  if (body.pair_shapes.length !== 72 || body.episode_shapes.length !== 144) throw new Error("LC4 schedule cardinality drifted");
  if (new Set(body.pair_shapes.map((pair) => pair.template_id)).size !== 24) throw new Error("LC4 template cardinality drifted");
  if (new Set(body.pair_shapes.map((pair) => pair.pair_id)).size !== 72) throw new Error("LC4 pair IDs are not unique");
  if (new Set(body.episode_shapes.map((episode) => episode.run_id)).size !== 144) throw new Error("LC4 run IDs are not unique");
  return deepFreeze({
    ...body,
    schedule_sha256: sha256Hex(`${SCHEDULE_DOMAIN}${canonicalJson(body)}`),
  });
}

export type Lc4QualificationGateReceipt = Readonly<{
  schema_version: 1;
  protocol_id: typeof LC4_RUNNER_PROTOCOL;
  plan_sha256: string;
  source_commit: string;
  configuration_matrix_sha256: string;
  credential_set_sha256: string;
  handshake: Readonly<{
    status: "conditional";
    artifact_sha256: string;
    completed_at: string;
  }>;
  response_tool_canary: Readonly<{
    status: "passed";
    artifact_sha256: string;
    completed_at: string;
    caller_audio_bytes: 0;
    providers_verified: readonly LiveStsProvider[];
  }>;
  gate_sha256: string;
}>;

export function createLc4QualificationGateReceipt(input: Omit<Lc4QualificationGateReceipt, "schema_version" | "protocol_id" | "gate_sha256">): Lc4QualificationGateReceipt {
  for (const [label, value] of Object.entries({
    plan_sha256: input.plan_sha256,
    configuration_matrix_sha256: input.configuration_matrix_sha256,
    credential_set_sha256: input.credential_set_sha256,
    handshake_artifact_sha256: input.handshake.artifact_sha256,
    tool_canary_artifact_sha256: input.response_tool_canary.artifact_sha256,
  })) requireHash(value, label);
  if (!/^[a-f0-9]{40}$/.test(input.source_commit)) throw new Error("qualification source commit must be a full Git SHA-1");
  if (input.handshake.status !== "conditional") throw new Error("LC4 gateway qualification must retain conditional handshake status");
  if (input.response_tool_canary.status !== "passed" || input.response_tool_canary.caller_audio_bytes !== 0) {
    throw new Error("LC4 conditional qualification requires a passing zero-caller-audio response/tool canary");
  }
  if (canonicalJson([...input.response_tool_canary.providers_verified].sort()) !== canonicalJson(["gemini", "openai", "xai"])) {
    throw new Error("LC4 response/tool canary must verify all three exact provider profiles");
  }
  for (const timestamp of [input.handshake.completed_at, input.response_tool_canary.completed_at]) {
    if (!Number.isFinite(Date.parse(timestamp))) throw new Error("qualification evidence timestamp is invalid");
  }
  const body = Object.freeze({ schema_version: 1 as const, protocol_id: LC4_RUNNER_PROTOCOL, ...input });
  return deepFreeze({ ...body, gate_sha256: sha256Hex(`${QUALIFICATION_DOMAIN}${canonicalJson(body)}`) });
}

export function assertLc4QualificationGateReceipt(
  receipt: Lc4QualificationGateReceipt,
  binding: Readonly<{
    plan_sha256: string;
    source_commit: string;
    configuration_matrix_sha256: string;
    credential_set_sha256: string;
  }>,
): void {
  const rebuilt = createLc4QualificationGateReceipt({
    plan_sha256: receipt.plan_sha256,
    source_commit: receipt.source_commit,
    configuration_matrix_sha256: receipt.configuration_matrix_sha256,
    credential_set_sha256: receipt.credential_set_sha256,
    handshake: receipt.handshake,
    response_tool_canary: receipt.response_tool_canary,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(receipt)) throw new Error("LC4 qualification gate receipt integrity failed");
  for (const key of ["plan_sha256", "source_commit", "configuration_matrix_sha256", "credential_set_sha256"] as const) {
    if (receipt[key] !== binding[key]) throw new Error(`LC4 qualification gate differs from ${key}`);
  }
}

export type Lc4OpportunityBinding = Readonly<{
  ordinal: number;
  opportunity_id: string;
  segment_ordinal: 1 | 2 | 3;
  caller_pcm_sha256: string;
  caller_pcm_byte_length: number;
  opportunity_contract_sha256: string;
}>;

export type Lc4BudgetReservationReceipt = Readonly<{
  reservation_id: string;
  run_id: string;
  provider: LiveStsProvider;
  model: string;
  maximum_micro_usd: number;
  status: "reserved";
  ledger_head_sha256: string;
  reservation_sha256: string;
}>;

export type Lc4EpisodeManifest = Readonly<{
  schema_version: 1;
  protocol_id: typeof LC4_RUNNER_PROTOCOL;
  runner_foundation_version: typeof LC4_RUNNER_FOUNDATION_VERSION;
  run_id: string;
  pair_id: string;
  episode_shape: Lc4EpisodeShape;
  schedule_sha256: string;
  source_commit: string;
  source_tree_sha256: string;
  preregistration_sha256: string;
  heldout_commitment_sha256: string;
  template_commitment_sha256: string;
  opportunity_manifest_sha256: string;
  caller_fixture_manifest_sha256: string;
  condition_suite_sha256: string;
  parity_manifest_sha256: string;
  generator_schedule_join_sha256: string;
  qualification: Lc4QualificationGateReceipt;
  budget_reservation: Lc4BudgetReservationReceipt;
  opportunities: readonly Lc4OpportunityBinding[];
  retry_policy: "one_consumable_run_id_no_paid_retry";
  provider_calls_authorized: false;
  execution_scope: "provider_free_foundation_validation_only";
  manifest_sha256: string;
}>;

export function createLc4EpisodeManifest(input: Readonly<{
  schedule: Lc4ProductionScheduleShape;
  run_id: string;
  source_commit: string;
  source_tree_sha256: string;
  preregistration_sha256: string;
  heldout_commitment_sha256: string;
  template_commitment_sha256: string;
  opportunity_manifest_sha256: string;
  caller_fixture_manifest_sha256: string;
  condition_suite_sha256: string;
  parity_manifest_sha256: string;
  generator_schedule_join_sha256?: string;
  qualification: Lc4QualificationGateReceipt;
  budget_reservation: Lc4BudgetReservationReceipt;
  opportunities: readonly Lc4OpportunityBinding[];
}>): Lc4EpisodeManifest {
  const episode = input.schedule.episode_shapes.find((candidate) => candidate.run_id === input.run_id);
  if (!episode) throw new Error("episode is absent from the frozen LC4 schedule");
  if (input.schedule.provider_calls_authorized !== false) throw new Error("LC4 foundation cannot authorize provider execution");
  if (!/^[a-f0-9]{40}$/.test(input.source_commit)) throw new Error("episode source commit must be a full Git SHA-1");
  const generatorScheduleJoinSha256 = input.generator_schedule_join_sha256
    ?? input.schedule.generator_join_contract_sha256;
  for (const [label, value] of Object.entries({
    source_tree_sha256: input.source_tree_sha256,
    preregistration_sha256: input.preregistration_sha256,
    heldout_commitment_sha256: input.heldout_commitment_sha256,
    template_commitment_sha256: input.template_commitment_sha256,
    opportunity_manifest_sha256: input.opportunity_manifest_sha256,
    caller_fixture_manifest_sha256: input.caller_fixture_manifest_sha256,
    condition_suite_sha256: input.condition_suite_sha256,
    parity_manifest_sha256: input.parity_manifest_sha256,
    generator_schedule_join_sha256: generatorScheduleJoinSha256,
  })) requireHash(value, label);
  if (
    input.budget_reservation.status !== "reserved"
    || input.budget_reservation.run_id !== episode.run_id
    || input.budget_reservation.provider !== episode.provider
    || input.budget_reservation.model !== episode.provider_profile.model
    || input.budget_reservation.maximum_micro_usd !== episode.maximum_reservation_micro_usd
  ) throw new Error("episode budget reservation differs from the frozen episode shape");
  requireId(input.budget_reservation.reservation_id, "reservation_id");
  requireHash(input.budget_reservation.ledger_head_sha256, "ledger_head_sha256");
  requireHash(input.budget_reservation.reservation_sha256, "reservation_sha256");
  if (input.opportunities.length !== 60) throw new Error("LC4 episode requires exactly 60 opportunity bindings");
  input.opportunities.forEach((opportunity, index) => {
    const expectedOrdinal = index + 1;
    const expectedSegment = Math.ceil(expectedOrdinal / 20) as 1 | 2 | 3;
    if (opportunity.ordinal !== expectedOrdinal || opportunity.segment_ordinal !== expectedSegment) {
      throw new Error("LC4 opportunity bindings must be contiguous across three 20-opportunity segments");
    }
    requireId(opportunity.opportunity_id, "opportunity_id");
    requireHash(opportunity.caller_pcm_sha256, "caller_pcm_sha256");
    requireHash(opportunity.opportunity_contract_sha256, "opportunity_contract_sha256");
    if (!Number.isSafeInteger(opportunity.caller_pcm_byte_length) || opportunity.caller_pcm_byte_length <= 0) {
      throw new Error("caller PCM byte length must be positive");
    }
  });
  if (new Set(input.opportunities.map((opportunity) => opportunity.opportunity_id)).size !== 60) {
    throw new Error("LC4 opportunity IDs must be unique");
  }
  const body = Object.freeze({
    schema_version: 1 as const,
    protocol_id: LC4_RUNNER_PROTOCOL,
    runner_foundation_version: LC4_RUNNER_FOUNDATION_VERSION,
    run_id: episode.run_id,
    pair_id: episode.pair_id,
    episode_shape: episode,
    schedule_sha256: input.schedule.schedule_sha256,
    source_commit: input.source_commit,
    source_tree_sha256: input.source_tree_sha256,
    preregistration_sha256: input.preregistration_sha256,
    heldout_commitment_sha256: input.heldout_commitment_sha256,
    template_commitment_sha256: input.template_commitment_sha256,
    opportunity_manifest_sha256: input.opportunity_manifest_sha256,
    caller_fixture_manifest_sha256: input.caller_fixture_manifest_sha256,
    condition_suite_sha256: input.condition_suite_sha256,
    parity_manifest_sha256: input.parity_manifest_sha256,
    generator_schedule_join_sha256: generatorScheduleJoinSha256,
    qualification: input.qualification,
    budget_reservation: input.budget_reservation,
    opportunities: Object.freeze([...input.opportunities]),
    retry_policy: "one_consumable_run_id_no_paid_retry" as const,
    provider_calls_authorized: false as const,
    execution_scope: "provider_free_foundation_validation_only" as const,
  });
  return deepFreeze({ ...body, manifest_sha256: sha256Hex(`${EPISODE_DOMAIN}${canonicalJson(body)}`) });
}

export type Lc4BudgetReservationAdapter = Readonly<{
  kind: "provider-free-test";
  reserve(input: Readonly<{
    run_id: string;
    provider: LiveStsProvider;
    model: string;
    maximum_micro_usd: number;
  }>): Promise<Lc4BudgetReservationReceipt>;
  connectionIntent(receipt: Lc4BudgetReservationReceipt): Promise<void>;
  opened(receipt: Lc4BudgetReservationReceipt): Promise<void>;
  terminal(receipt: Lc4BudgetReservationReceipt, outcome: "completed" | "failed"): Promise<void>;
}>;

export type Lc4AttemptAdapter = Readonly<{
  kind: "provider-free-test";
  consume(run_id: string, manifest_sha256: string): Promise<Readonly<{ attempt_id: string }>>;
  markIttOpened(attempt_id: string, opportunity_id: string): Promise<void>;
  terminal(attempt_id: string, outcome: "completed" | "failed", itt_opened: boolean): Promise<void>;
}>;

export type Lc4CallerAdapter = Readonly<{
  kind: "provider-free-test";
  load(opportunity: Lc4OpportunityBinding): Promise<Readonly<{ pcm: Uint8Array }>>;
}>;

export type Lc4AudioRetentionAdapter = Readonly<{
  kind: "provider-free-test";
  retain(input: Readonly<{
    run_id: string;
    opportunity_id: string;
    direction: "caller_input" | "assistant_output";
    pcm: Uint8Array;
  }>): Promise<Readonly<{ artifact_sha256: string; byte_length: number }>>;
}>;

export type Lc4ProviderSegmentSession = Readonly<{
  sendCallerAudio(input: Readonly<{ opportunity_id: string; pcm: Uint8Array }>): Promise<void>;
  receiveAssistantAudio(input: Readonly<{ opportunity_id: string }>): Promise<Readonly<{ pcm: Uint8Array }>>;
  close(): Promise<void>;
}>;

export type Lc4ProviderAdapter = Readonly<{
  kind: "provider-free-test";
  openSegment(input: Readonly<{
    manifest: Lc4EpisodeManifest;
    segment: Lc4SegmentShape;
    profile: Lc4ProviderExecutionProfile;
  }>): Promise<Lc4ProviderSegmentSession>;
}>;

export type Lc4ProviderFreeRunResult = Readonly<{
  run_id: string;
  status: "completed" | "failed";
  itt_opened: boolean;
  segments_opened: number;
  opportunities_sent: number;
  assistant_outputs_retained: number;
  failure_class: "scenario-invalid" | "system-failure" | "transport" | null;
  result_sha256: string;
}>;

/**
 * Provider-free lifecycle emulator for validating the production runner's
 * segmentation, evidence retention, budget transitions, and one-shot ITT
 * semantics. It cannot accept a production/network adapter.
 */
export async function executeLc4ProviderFreeEpisode(input: Readonly<{
  manifest: Lc4EpisodeManifest;
  qualification_binding: Readonly<{
    plan_sha256: string;
    source_commit: string;
    configuration_matrix_sha256: string;
    credential_set_sha256: string;
  }>;
  budget: Lc4BudgetReservationAdapter;
  attempts: Lc4AttemptAdapter;
  caller: Lc4CallerAdapter;
  audio: Lc4AudioRetentionAdapter;
  provider: Lc4ProviderAdapter;
}>): Promise<Lc4ProviderFreeRunResult> {
  for (const adapter of [input.budget, input.attempts, input.caller, input.audio, input.provider]) {
    if (adapter.kind !== "provider-free-test") throw new Error("LC4 paid execution remains frozen; only provider-free adapters are accepted");
  }
  assertLc4QualificationGateReceipt(input.manifest.qualification, input.qualification_binding);
  const expectedManifest = createLc4EpisodeManifest({
    schedule: compileLc4ProductionScheduleShape(),
    run_id: input.manifest.run_id,
    source_commit: input.manifest.source_commit,
    source_tree_sha256: input.manifest.source_tree_sha256,
    preregistration_sha256: input.manifest.preregistration_sha256,
    heldout_commitment_sha256: input.manifest.heldout_commitment_sha256,
    template_commitment_sha256: input.manifest.template_commitment_sha256,
    opportunity_manifest_sha256: input.manifest.opportunity_manifest_sha256,
    caller_fixture_manifest_sha256: input.manifest.caller_fixture_manifest_sha256,
    condition_suite_sha256: input.manifest.condition_suite_sha256,
    parity_manifest_sha256: input.manifest.parity_manifest_sha256,
    generator_schedule_join_sha256: input.manifest.generator_schedule_join_sha256,
    qualification: input.manifest.qualification,
    budget_reservation: input.manifest.budget_reservation,
    opportunities: input.manifest.opportunities,
  });
  if (canonicalJson(expectedManifest) !== canonicalJson(input.manifest)) throw new Error("LC4 episode manifest integrity failed");

  const attempt = await input.attempts.consume(input.manifest.run_id, input.manifest.manifest_sha256);
  requireId(attempt.attempt_id, "attempt_id");
  await input.budget.connectionIntent(input.manifest.budget_reservation);
  let ittOpened = false;
  let segmentsOpened = 0;
  let opportunitiesSent = 0;
  let outputsRetained = 0;
  let activeFailureClass: Exclude<Lc4ProviderFreeRunResult["failure_class"], null> = "transport";
  try {
    for (const segment of input.manifest.episode_shape.segments) {
      activeFailureClass = "transport";
      const session = await input.provider.openSegment({
        manifest: input.manifest,
        segment,
        profile: input.manifest.episode_shape.provider_profile,
      });
      segmentsOpened += 1;
      try {
        const opportunities = input.manifest.opportunities.filter((opportunity) => opportunity.segment_ordinal === segment.ordinal);
        if (opportunities.length !== 20) throw new Error("LC4 segment does not contain exactly 20 opportunities");
        for (const opportunity of opportunities) {
          activeFailureClass = "scenario-invalid";
          const caller = await input.caller.load(opportunity);
          if (caller.pcm.byteLength !== opportunity.caller_pcm_byte_length || sha256Hex(caller.pcm) !== opportunity.caller_pcm_sha256) {
            throw new Error("caller PCM differs from immutable opportunity binding");
          }
          activeFailureClass = "system-failure";
          const retainedInput = await input.audio.retain({
            run_id: input.manifest.run_id,
            opportunity_id: opportunity.opportunity_id,
            direction: "caller_input",
            pcm: caller.pcm,
          });
          if (retainedInput.byte_length !== caller.pcm.byteLength || retainedInput.artifact_sha256 !== sha256Hex(caller.pcm)) {
            throw new Error("caller audio retention receipt is invalid");
          }
          if (!ittOpened) {
            ittOpened = true;
            await input.attempts.markIttOpened(attempt.attempt_id, opportunity.opportunity_id);
            await input.budget.opened(input.manifest.budget_reservation);
          }
          activeFailureClass = "transport";
          await session.sendCallerAudio({ opportunity_id: opportunity.opportunity_id, pcm: caller.pcm });
          opportunitiesSent += 1;
          const output = await session.receiveAssistantAudio({ opportunity_id: opportunity.opportunity_id });
          if (output.pcm.byteLength === 0) throw new Error("provider-free output audio is empty");
          activeFailureClass = "system-failure";
          const retainedOutput = await input.audio.retain({
            run_id: input.manifest.run_id,
            opportunity_id: opportunity.opportunity_id,
            direction: "assistant_output",
            pcm: output.pcm,
          });
          if (retainedOutput.byte_length !== output.pcm.byteLength || retainedOutput.artifact_sha256 !== sha256Hex(output.pcm)) {
            throw new Error("assistant audio retention receipt is invalid");
          }
          outputsRetained += 1;
        }
      } finally {
        activeFailureClass = "transport";
        await session.close();
      }
    }
    activeFailureClass = "scenario-invalid";
    if (segmentsOpened !== 3 || opportunitiesSent !== 60 || outputsRetained !== 60) {
      throw new Error("LC4 episode did not complete its exact segmented horizon");
    }
    await input.attempts.terminal(attempt.attempt_id, "completed", ittOpened);
    await input.budget.terminal(input.manifest.budget_reservation, "completed");
    return runResult({
      run_id: input.manifest.run_id,
      status: "completed",
      itt_opened: ittOpened,
      segments_opened: segmentsOpened,
      opportunities_sent: opportunitiesSent,
      assistant_outputs_retained: outputsRetained,
      failure_class: null,
    });
  } catch {
    await input.attempts.terminal(attempt.attempt_id, "failed", ittOpened);
    await input.budget.terminal(input.manifest.budget_reservation, "failed");
    return runResult({
      run_id: input.manifest.run_id,
      status: "failed",
      itt_opened: ittOpened,
      segments_opened: segmentsOpened,
      opportunities_sent: opportunitiesSent,
      assistant_outputs_retained: outputsRetained,
      failure_class: activeFailureClass,
    });
  }
}

/** Reserve one exact frozen episode without opening or importing a provider client. */
export async function reserveLc4ProviderFreeEpisodeBudget(input: Readonly<{
  schedule: Lc4ProductionScheduleShape;
  run_id: string;
  budget: Lc4BudgetReservationAdapter;
}>): Promise<Lc4BudgetReservationReceipt> {
  if (input.budget.kind !== "provider-free-test") throw new Error("LC4 paid budget execution remains frozen");
  const episode = input.schedule.episode_shapes.find((candidate) => candidate.run_id === input.run_id);
  if (!episode) throw new Error("budget request is absent from the frozen LC4 schedule");
  const receipt = await input.budget.reserve({
    run_id: episode.run_id,
    provider: episode.provider,
    model: episode.provider_profile.model,
    maximum_micro_usd: episode.maximum_reservation_micro_usd,
  });
  if (
    receipt.status !== "reserved"
    || receipt.run_id !== episode.run_id
    || receipt.provider !== episode.provider
    || receipt.model !== episode.provider_profile.model
    || receipt.maximum_micro_usd !== episode.maximum_reservation_micro_usd
  ) throw new Error("budget adapter returned a reservation outside the frozen episode envelope");
  requireId(receipt.reservation_id, "reservation_id");
  requireHash(receipt.ledger_head_sha256, "ledger_head_sha256");
  requireHash(receipt.reservation_sha256, "reservation_sha256");
  return deepFreeze(receipt);
}

function runResult(body: Omit<Lc4ProviderFreeRunResult, "result_sha256">): Lc4ProviderFreeRunResult {
  return deepFreeze({
    ...body,
    result_sha256: sha256Hex(`harshas-amazing-call-center/lc4-provider-free-run-result/v1\n${canonicalJson(body)}`),
  });
}

function requireHash(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
}

function requireId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${label} must be a safe identifier`);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
