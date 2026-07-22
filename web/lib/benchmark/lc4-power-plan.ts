import { canonicalJson, sha256Hex } from "./artifacts";
import { exactConditionalMcNemarPower } from "./statistics";

export const LC4_POWER_ARTIFACT_ID = "HACC-LC4-POWER-v1" as const;
export const LC4_POWER_PLAN_SEED = "hacc-lc4-power-plan-20260721-v1" as const;
const ARTIFACT_DOMAIN = "harshas-amazing-call-center/lc4-power-plan/v1\n";

const PROVIDERS = Object.freeze(["openai", "gemini", "xai"] as const);
const FAMILIES = Object.freeze([
  "freight-customs",
  "fleet-repair",
  "live-event",
  "invoice-dispute",
  "equipment-rental",
  "datacenter-maintenance",
] as const);
const VARIANTS = Object.freeze([
  "branch-changing-correction",
  "two-goal-resumption",
  "async-result-conflict",
  "committed-effect-reconciliation",
] as const);
const TTS_VOICE_SLOTS = Object.freeze(["tts-slot-1", "tts-slot-2", "tts-slot-3"] as const);

function seededOrder<const T extends readonly string[]>(values: T, label: string): T[number][] {
  return [...values].sort((left, right) => {
    const leftHash = sha256Hex(`${LC4_POWER_PLAN_SEED}\n${label}\n${left}`);
    const rightHash = sha256Hex(`${LC4_POWER_PLAN_SEED}\n${label}\n${right}`);
    return leftHash.localeCompare(rightHash);
  });
}

function rotate<T>(values: readonly T[], offset: number): readonly T[] {
  return Object.freeze(values.map((_, index) => values[(index + offset) % values.length]));
}

function countBy<T>(values: readonly T[], key: (value: T) => string): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[key(value)] = (counts[key(value)] ?? 0) + 1;
  return Object.freeze(Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))));
}

function powerScenario(haccOnly: number, nativeOnly: number) {
  const discordance = haccOnly + nativeOnly;
  const riskDifference = haccOnly - nativeOnly;
  return Object.freeze({
    hacc_only_probability: haccOnly,
    native_only_probability: nativeOnly,
    ...exactConditionalMcNemarPower({
      sample_size: 72,
      risk_difference: riskDifference,
      discordance,
      alpha: 0.05,
    }),
  });
}

function clusterSensitivity(icc: number, discordance: number) {
  const designEffect = 1 + (3 - 1) * icc;
  const effectivePairs = Math.floor(72 / designEffect);
  const power = exactConditionalMcNemarPower({
    sample_size: effectivePairs,
    risk_difference: 0.25,
    discordance,
    alpha: 0.05,
  }).power;
  return Object.freeze({
    within_template_provider_icc: icc,
    providers_per_template: 3,
    design_effect: designEffect,
    effective_pairs_floor: effectivePairs,
    exact_power_at_effective_pairs: power,
  });
}

export function createLc4PowerPlanArtifact() {
  const familyOrder = seededOrder(FAMILIES, "family-order");
  const variantOrder = seededOrder(VARIANTS, "variant-order");
  const providerOrder = seededOrder(PROVIDERS, "provider-order");
  const voiceOrder = seededOrder(TTS_VOICE_SLOTS, "tts-voice-slot-order");
  const familyRank = new Map(familyOrder.map((value, index) => [value, index]));
  const variantRank = new Map(variantOrder.map((value, index) => [value, index]));
  const providerRank = new Map(providerOrder.map((value, index) => [value, index]));

  const templates = FAMILIES.flatMap((family, familyIndex) => VARIANTS.map((variant, variantIndex) => {
    const randomizedFamilyRank = familyRank.get(family)!;
    const randomizedVariantRank = variantRank.get(variant)!;
    const templateOrdinal = familyIndex * VARIANTS.length + variantIndex + 1;
    return Object.freeze({
      template_id: `lc4-template-${String(templateOrdinal).padStart(2, "0")}`,
      family,
      structural_variant: variant,
      tts_voice_slot: voiceOrder[(randomizedFamilyRank + randomizedVariantRank) % voiceOrder.length],
      provider_execution_order: rotate(providerOrder, (templateOrdinal - 1) % providerOrder.length),
      randomized_family_rank: randomizedFamilyRank + 1,
      randomized_variant_rank: randomizedVariantRank + 1,
    });
  }));
  const assignments = templates.flatMap((template) => PROVIDERS.map((provider) => {
    const ab = (
      template.randomized_family_rank - 1
      + template.randomized_variant_rank - 1
      + providerRank.get(provider)!
    ) % 2 === 0;
    return Object.freeze({
      pair_id: `${template.template_id}-${provider}`,
      template_id: template.template_id,
      provider,
      family: template.family,
      structural_variant: template.structural_variant,
      tts_voice_slot: template.tts_voice_slot,
      arm_order: Object.freeze(ab ? ["native", "hacc"] as const : ["hacc", "native"] as const),
      provider_execution_order: template.provider_execution_order,
    });
  }));
  const balance = Object.freeze({
    by_provider_and_order: countBy(assignments, (item) => `${item.provider}/${item.arm_order.join("-")}`),
    by_provider_family_and_order: countBy(assignments, (item) => `${item.provider}/${item.family}/${item.arm_order.join("-")}`),
    by_provider_variant_and_order: countBy(assignments, (item) => `${item.provider}/${item.structural_variant}/${item.arm_order.join("-")}`),
    by_provider_tts_slot_and_order: countBy(assignments, (item) => `${item.provider}/${item.tts_voice_slot}/${item.arm_order.join("-")}`),
    provider_execution_position: countBy(templates.flatMap((template) => template.provider_execution_order.map((provider, index) => ({ provider, index }))), (item) => `${item.provider}/position-${item.index + 1}`),
  });
  const exactPower = Object.freeze([
    powerScenario(0.30, 0.05),
    powerScenario(0.35, 0.10),
  ]);
  const clusterIccValues = Object.freeze([0, 0.10, 0.25, 0.50, 1]);
  const body = Object.freeze({
    schema_version: 1 as const,
    artifact_id: LC4_POWER_ARTIFACT_ID,
    protocol_id: "HACC-LC4-v1" as const,
    status: "outcome-blind planning artifact; not a preregistration or run authorization" as const,
    created_at: "2026-07-21T00:00:00.000Z" as const,
    outcome_blindness: Object.freeze({
      lc3_treatment_effect_outcomes_used: false,
      nuisance_parameters_source: "prospective alternatives stated in HACC_LC4_V1_PROTOCOL_DRAFT.md",
      resizing_rule: "no optional stopping, outcome-based sample-size re-estimation, provider removal, family removal, or endpoint substitution",
    }),
    schedule: Object.freeze({
      independent_templates: 24,
      provider_strata: 3,
      matched_pairs: 72,
      episodes: 144,
      caller_opportunities_per_episode: 60,
      scheduled_caller_opportunities: 8_640,
      providers: PROVIDERS,
      families: FAMILIES,
      structural_variants: VARIANTS,
      tts_voice_slots: TTS_VOICE_SLOTS,
    }),
    randomization: Object.freeze({
      seed: LC4_POWER_PLAN_SEED,
      method: "seeded constrained rank-parity allocation with exact marginal balance",
      arm_labels: Object.freeze(["native", "hacc"] as const),
      provider_execution_method: "seeded provider order rotated as a three-period Latin square",
      assignments: Object.freeze(assignments),
      balance,
      allocation_sha256: sha256Hex(`hacc-lc4/allocation/v1\n${canonicalJson(assignments)}`),
    }),
    primary_analysis: Object.freeze({
      estimand: "equal-provider-weight paired risk difference in bounded useful completion",
      null_test: "planned exact provider-stratified constrained paired randomization test; executable enumeration required before preregistration",
      statistic: "mean of the three provider-specific paired risk differences",
      randomization_unit: "provider-template pair",
      randomization_support_size: "not 2^72 because exact marginal balance constrains assignments; support must be derived from the frozen allocation generator before preregistration",
      interval: "paired template-cluster bootstrap over 24 templates",
      provider_specific_rows: "descriptive; n=24 pairs/provider is not powered for provider-specific claims",
      missingness: "all opened or missing episodes remain ITT failures; no retries",
    }),
    exact_independent_pair_power: Object.freeze({
      method_scope: "exact two-sided conditional McNemar power under independent provider-template pairs",
      alpha: 0.05,
      minimally_important_risk_difference: 0.25,
      scenarios: exactPower,
    }),
    template_cluster_sensitivity: Object.freeze({
      method_scope: "design-effect floor sensitivity, not power for the final cluster-bootstrap decision rule",
      formula: "design_effect = 1 + (3 - 1) * ICC; effective_pairs = floor(72 / design_effect)",
      rows: Object.freeze(clusterIccValues.flatMap((icc) => [
        Object.freeze({ alternative: "hacc-only-0.30_native-only-0.05", ...clusterSensitivity(icc, 0.35) }),
        Object.freeze({ alternative: "hacc-only-0.35_native-only-0.10", ...clusterSensitivity(icc, 0.45) }),
      ])),
      perfect_cluster_note: "ICC=1 reduces the sensitivity calculation to 24 effective template pairs; provider-specific rows and clustered confirmation remain descriptive unless separately powered.",
    }),
    claim_boundaries: Object.freeze([
      "The exact calculations do not include provider heterogeneity, the template-cluster bootstrap decision rule, missingness, safety conjunctions, or multiplicity.",
      "The exact McNemar power calculation is not power for the still-unimplemented constrained randomization test.",
      "The design-effect rows are sensitivity diagnostics, not confirmatory power guarantees.",
      "A favorable pooled result does not establish success for every provider, and provider-specific rows remain descriptive.",
      "LC3 outcomes are development evidence and were not used to choose LC4 power assumptions or resize the schedule.",
      "This artifact authorizes zero provider calls and zero efficacy claims.",
    ]),
  });
  return Object.freeze({
    ...body,
    artifact_sha256: sha256Hex(`${ARTIFACT_DOMAIN}${canonicalJson(body)}`),
  });
}

export type Lc4PowerPlanArtifact = ReturnType<typeof createLc4PowerPlanArtifact>;
