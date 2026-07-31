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

// V8/libm revisions can differ by one or two ULPs in the accumulated exact
// binomial power. Canonical artifacts must be byte-identical across supported
// Node runtimes, so freeze probabilities well beyond inferential precision.
function canonicalProbability(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("probability must be finite and within [0,1]");
  }
  return Number(value.toPrecision(14));
}

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

function enumerateConstrainedProviderSupport<TRow extends Readonly<{
  template_id: string;
  family: string;
  structural_variant: string;
  tts_voice_slot: string;
}>>(templates: readonly TRow[]): readonly string[] {
  const ordered = [...templates].sort((left, right) => left.template_id.localeCompare(right.template_id));
  const familyGroups = FAMILIES.map((family) => ordered
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.family === family)
    .map(({ index }) => index));
  const support: string[] = [];
  const selected = new Set<number>();

  function visit(familyIndex: number): void {
    if (familyIndex === familyGroups.length) {
      const rows = ordered.filter((_, index) => selected.has(index));
      if (VARIANTS.some((variant) => rows.filter((row) => row.structural_variant === variant).length !== 3)) return;
      if (TTS_VOICE_SLOTS.some((voice) => rows.filter((row) => row.tts_voice_slot === voice).length !== 4)) return;
      support.push(ordered.map((_, index) => selected.has(index) ? "1" : "0").join(""));
      return;
    }
    const group = familyGroups[familyIndex];
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        selected.add(group[left]);
        selected.add(group[right]);
        visit(familyIndex + 1);
        selected.delete(group[left]);
        selected.delete(group[right]);
      }
    }
  }

  visit(0);
  return Object.freeze(support.sort());
}

function selectUniformSupportIndex(provider: string, supportSize: number) {
  if (!Number.isSafeInteger(supportSize) || supportSize <= 0) throw new Error("supportSize must be positive");
  const range = BigInt(1) << BigInt(256);
  const size = BigInt(supportSize);
  const rejectionLimit = range - (range % size);
  for (let counter = 0; counter < 1_000; counter += 1) {
    const digest = sha256Hex(`${LC4_POWER_PLAN_SEED}\nconstrained-provider-allocation\n${provider}\n${counter}`);
    const value = BigInt(`0x${digest}`);
    if (value < rejectionLimit) {
      return Object.freeze({
        support_index: Number(value % size),
        sha256_digest: digest,
        rejection_counter: counter,
      });
    }
  }
  throw new Error("SHA-256 rejection sampler did not terminate within 1,000 draws");
}

function powerScenario(haccOnly: number, nativeOnly: number) {
  const discordance = haccOnly + nativeOnly;
  const riskDifference = haccOnly - nativeOnly;
  const exact = exactConditionalMcNemarPower({
    sample_size: 72,
    risk_difference: riskDifference,
    discordance,
    alpha: 0.05,
  });
  return Object.freeze({
    hacc_only_probability: haccOnly,
    native_only_probability: nativeOnly,
    ...exact,
    power: canonicalProbability(exact.power),
  });
}

function clusterSensitivity(icc: number, discordance: number) {
  const designEffect = 1 + (3 - 1) * icc;
  const effectivePairs = Math.floor(72 / designEffect);
  const power = canonicalProbability(exactConditionalMcNemarPower({
    sample_size: effectivePairs,
    risk_difference: 0.25,
    discordance,
    alpha: 0.05,
  }).power);
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
  const constrainedSupport = enumerateConstrainedProviderSupport(templates);
  const providerSelections = Object.freeze(Object.fromEntries(PROVIDERS.map((provider) => {
    const selection = selectUniformSupportIndex(provider, constrainedSupport.length);
    return [provider, Object.freeze({
      ...selection,
      native_first_bitstring: constrainedSupport[selection.support_index],
    })];
  })) as Record<(typeof PROVIDERS)[number], Readonly<{
    support_index: number;
    sha256_digest: string;
    rejection_counter: number;
    native_first_bitstring: string;
  }>>);
  const templateIndex = new Map([...templates]
    .sort((left, right) => left.template_id.localeCompare(right.template_id))
    .map((template, index) => [template.template_id, index]));
  const assignments = templates.flatMap((template) => PROVIDERS.map((provider) => {
    const nativeFirst = providerSelections[provider].native_first_bitstring[templateIndex.get(template.template_id)!] === "1";
    return Object.freeze({
      pair_id: `${template.template_id}-${provider}`,
      template_id: template.template_id,
      provider,
      family: template.family,
      structural_variant: template.structural_variant,
      tts_voice_slot: template.tts_voice_slot,
      arm_order: Object.freeze(nativeFirst ? ["native", "hacc"] as const : ["hacc", "native"] as const),
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
      method: "provider-independent SHA-256 rejection-sampled selection from the complete constrained support",
      arm_labels: Object.freeze(["native", "hacc"] as const),
      provider_support_size: constrainedSupport.length,
      joint_support_size: (BigInt(constrainedSupport.length) ** BigInt(PROVIDERS.length)).toString(),
      provider_selections: providerSelections,
      provider_execution_method: "seeded provider order rotated as a three-period Latin square",
      assignments: Object.freeze(assignments),
      balance,
      allocation_sha256: sha256Hex(`hacc-lc4/allocation/v1\n${canonicalJson(assignments)}`),
    }),
    primary_analysis: Object.freeze({
      estimand: "equal-provider-weight paired risk difference in bounded useful completion",
      null_test: "exact provider-stratified constrained paired randomization test implemented by HACC-LC4-CONSTRAINED-INFERENCE-v1",
      statistic: "mean of the three provider-specific paired risk differences",
      randomization_unit: "provider-template pair",
      randomization_support_size: "504 assignments/provider and 128,024,064 joint assignments; not 2^72 because frozen margins constrain allocation",
      interval: "100,000-draw paired template-cluster percentile bootstrap over 24 templates with a frozen DKW Monte Carlo error bound",
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
      "The exact McNemar power calculation is not power for the executable constrained randomization test or the clustered final decision rule.",
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
