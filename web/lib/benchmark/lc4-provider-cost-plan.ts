import { z } from "zod";
import { canonicalJson, sha256Hex } from "./artifacts";

export const LC4_COST_PLAN_PROTOCOL = "HACC-LC4-v1" as const;
export const LC4_COST_PLAN_EPISODES = 144 as const;
export const LC4_COST_PLAN_TURNS = 8_640 as const;
export const LC4_COST_PLAN_SCHEDULING_CEILING_MICRO_USD = 900_000_000 as const;
export const LC4_COST_PLAN_MAX_PRICING_AGE_DAYS = 7 as const;

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const PositiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const NonNegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const SourceSchema = z.object({
  url: z.string().url().refine((value) => value.startsWith("https://"), "pricing source must use HTTPS"),
  accessed_on: DateSchema,
}).strict();

const OpenAiPricingSchema = z.object({
  provider: z.literal("openai"),
  model: z.literal("gpt-realtime-2.1"),
  source: SourceSchema,
  rates: z.object({
    input_text_micro_usd_per_million_tokens: z.literal(4_000_000),
    cached_input_text_micro_usd_per_million_tokens: z.literal(400_000),
    input_audio_micro_usd_per_million_tokens: z.literal(32_000_000),
    cached_input_audio_micro_usd_per_million_tokens: z.literal(400_000),
    output_text_micro_usd_per_million_tokens: z.literal(24_000_000),
    output_audio_micro_usd_per_million_tokens: z.literal(64_000_000),
  }).strict(),
}).strict();

const GeminiPricingSchema = z.object({
  provider: z.literal("gemini"),
  model: z.literal("gemini-3.1-flash-live-preview"),
  source: SourceSchema,
  rates: z.object({
    input_text_micro_usd_per_million_tokens: z.literal(750_000),
    input_audio_micro_usd_per_million_tokens: z.literal(3_000_000),
    output_text_micro_usd_per_million_tokens: z.literal(4_500_000),
    output_audio_micro_usd_per_million_tokens: z.literal(12_000_000),
  }).strict(),
  unclassified_token_policy: z.literal("charge_at_max_same_direction_modality_rate"),
}).strict();

const XaiPricingSchema = z.object({
  provider: z.literal("xai"),
  model: z.literal("grok-voice-think-fast-1.0"),
  source: SourceSchema,
  rates: z.object({
    audio_micro_usd_per_minute: z.literal(50_000),
    text_input_micro_usd_per_event: z.literal(4_000),
  }).strict(),
}).strict();

const OpenAiUsageSchema = z.object({
  provider: z.literal("openai"),
  model: z.literal("gpt-realtime-2.1"),
  observed_episodes: PositiveSafeInteger,
  observed_caller_turns: PositiveSafeInteger,
  usage_events: PositiveSafeInteger,
  input_text_tokens: NonNegativeSafeInteger,
  cached_input_text_tokens: NonNegativeSafeInteger,
  input_audio_tokens: NonNegativeSafeInteger,
  cached_input_audio_tokens: NonNegativeSafeInteger,
  output_text_tokens: NonNegativeSafeInteger,
  output_audio_tokens: NonNegativeSafeInteger,
}).strict();

const GeminiUsageSchema = z.object({
  provider: z.literal("gemini"),
  model: z.literal("gemini-3.1-flash-live-preview"),
  observed_episodes: PositiveSafeInteger,
  observed_caller_turns: PositiveSafeInteger,
  usage_events: PositiveSafeInteger,
  input_text_tokens: NonNegativeSafeInteger,
  input_audio_tokens: NonNegativeSafeInteger,
  unclassified_input_tokens: NonNegativeSafeInteger,
  output_text_tokens: NonNegativeSafeInteger,
  output_audio_tokens: NonNegativeSafeInteger,
  unclassified_output_tokens: NonNegativeSafeInteger,
}).strict();

const XaiUsageSchema = z.object({
  provider: z.literal("xai"),
  model: z.literal("grok-voice-think-fast-1.0"),
  observed_episodes: PositiveSafeInteger,
  observed_caller_turns: PositiveSafeInteger,
  usage_events: PositiveSafeInteger,
  input_audio_micro_minutes: NonNegativeSafeInteger,
  output_audio_micro_minutes: NonNegativeSafeInteger,
  billable_text_input_events: NonNegativeSafeInteger,
}).strict();

const EnvelopeSchema = z.object({
  usage_multiplier_ppm: PositiveSafeInteger,
  provider_micro_usd: z.object({
    openai: NonNegativeSafeInteger,
    gemini: NonNegativeSafeInteger,
    xai: NonNegativeSafeInteger,
  }).strict(),
  total_micro_usd: NonNegativeSafeInteger,
}).strict();

export const Lc4ProviderCostPlanSchema = z.object({
  schema_version: z.literal(1),
  protocol_id: z.literal(LC4_COST_PLAN_PROTOCOL),
  artifact_id: z.literal("lc4-provider-cost-plan-v1"),
  created_on: z.literal("2026-07-21"),
  currency: z.literal("USD"),
  schedule: z.object({
    episodes: z.literal(LC4_COST_PLAN_EPISODES),
    episodes_per_provider: z.literal(48),
    caller_turns_per_episode: z.literal(60),
    logical_segments_per_episode: z.literal(3),
    caller_turns_per_segment: z.literal(20),
    scheduled_caller_turns: z.literal(LC4_COST_PLAN_TURNS),
    provider_caller_turns: z.literal(2_880),
  }).strict(),
  limits: z.object({
    scheduling_ceiling_micro_usd: z.literal(LC4_COST_PLAN_SCHEDULING_CEILING_MICRO_USD),
    pricing_max_age_days: z.literal(LC4_COST_PLAN_MAX_PRICING_AGE_DAYS),
  }).strict(),
  pricing: z.tuple([OpenAiPricingSchema, GeminiPricingSchema, XaiPricingSchema]),
  retained_development_source: z.object({
    experiment_id: z.literal("hacc-lc3-v8"),
    protocol_id: z.literal("HACC-LC3-v6"),
    collected_on: z.literal("2026-07-21"),
    source_commit: z.literal("88a5d03a8bc762481519dd03f478b5d463201258"),
    retained_result_file_sha256: z.literal("cba41cddf3dbc42a27d7fe69300a1c933e9aced731a0bff9cc786255edcf924a"),
    derivation_scope: z.literal("provider_aggregate_usage_only_no_condition_or_outcome_fields"),
    aggregate_usage_sha256: z.literal("43e2d7145c1aae357c9277df32f9a1f83d257b1644c3b0d80d3b28dfed44fae6"),
  }).strict(),
  aggregate_usage: z.tuple([OpenAiUsageSchema, GeminiUsageSchema, XaiUsageSchema]),
  envelope_policy: z.object({
    scale_basis: z.literal("observed_provider_cost_per_caller_turn_times_2880_provider_turns"),
    segment_basis: z.literal("three_20_turn_segments_match_retained_20_turn_development_horizon"),
    low_multiplier_ppm: z.literal(750_000),
    nominal_multiplier_ppm: z.literal(1_000_000),
    stress_multiplier_ppm: z.literal(1_500_000),
  }).strict(),
  envelopes: z.object({
    low: EnvelopeSchema,
    nominal: EnvelopeSchema,
    stress: EnvelopeSchema,
  }).strict(),
}).strict();

export type Lc4ProviderCostPlan = z.infer<typeof Lc4ProviderCostPlanSchema>;

type CostEnvelope = Readonly<{
  usage_multiplier_ppm: number;
  provider_micro_usd: Readonly<{ openai: number; gemini: number; xai: number }>;
  total_micro_usd: number;
}>;

function ceilDiv(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || numerator < 0 || !Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new Error("LC4 cost arithmetic exceeded safe integer bounds");
  }
  return Math.floor(numerator / denominator) + (numerator % denominator === 0 ? 0 : 1);
}

function ceilProductDiv(numerators: readonly number[], denominators: readonly number[]): number {
  if ([...numerators, ...denominators].some((value) => !Number.isSafeInteger(value) || value < 0)
    || denominators.some((value) => value === 0)) {
    throw new Error("LC4 cost arithmetic received an invalid integer");
  }
  const zero = BigInt(0);
  const one = BigInt(1);
  const numerator = numerators.reduce((total, value) => total * BigInt(value), one);
  const denominator = denominators.reduce((total, value) => total * BigInt(value), one);
  const quotient = numerator / denominator + (numerator % denominator === zero ? zero : one);
  if (quotient > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("LC4 cost arithmetic exceeded safe integer bounds");
  return Number(quotient);
}

function tokenCost(tokens: number, rate: number): number {
  return ceilDiv(tokens * rate, 1_000_000);
}

export function lc4AggregateUsageSha256(plan: Pick<Lc4ProviderCostPlan, "aggregate_usage">): string {
  return sha256Hex(`hacc-lc4/provider-aggregate-usage/v1\n${canonicalJson(plan.aggregate_usage)}`);
}

export function calculateLc4CostEnvelopes(
  plan: Pick<Lc4ProviderCostPlan, "pricing" | "aggregate_usage" | "schedule" | "envelope_policy">,
): Readonly<{ low: CostEnvelope; nominal: CostEnvelope; stress: CostEnvelope }> {
  const [openAiPricing, geminiPricing, xaiPricing] = plan.pricing;
  const [openAiUsage, geminiUsage, xaiUsage] = plan.aggregate_usage;
  if (openAiUsage.cached_input_text_tokens > openAiUsage.input_text_tokens
    || openAiUsage.cached_input_audio_tokens > openAiUsage.input_audio_tokens) {
    throw new Error("OpenAI cached usage exceeds total input usage");
  }
  const openAiObserved = tokenCost(
    openAiUsage.input_text_tokens - openAiUsage.cached_input_text_tokens,
    openAiPricing.rates.input_text_micro_usd_per_million_tokens,
  ) + tokenCost(
    openAiUsage.cached_input_text_tokens,
    openAiPricing.rates.cached_input_text_micro_usd_per_million_tokens,
  ) + tokenCost(
    openAiUsage.input_audio_tokens - openAiUsage.cached_input_audio_tokens,
    openAiPricing.rates.input_audio_micro_usd_per_million_tokens,
  ) + tokenCost(
    openAiUsage.cached_input_audio_tokens,
    openAiPricing.rates.cached_input_audio_micro_usd_per_million_tokens,
  ) + tokenCost(openAiUsage.output_text_tokens, openAiPricing.rates.output_text_micro_usd_per_million_tokens)
    + tokenCost(openAiUsage.output_audio_tokens, openAiPricing.rates.output_audio_micro_usd_per_million_tokens);

  const geminiObserved = tokenCost(geminiUsage.input_text_tokens, geminiPricing.rates.input_text_micro_usd_per_million_tokens)
    + tokenCost(geminiUsage.input_audio_tokens, geminiPricing.rates.input_audio_micro_usd_per_million_tokens)
    + tokenCost(
      geminiUsage.unclassified_input_tokens,
      Math.max(
        geminiPricing.rates.input_text_micro_usd_per_million_tokens,
        geminiPricing.rates.input_audio_micro_usd_per_million_tokens,
      ),
    )
    + tokenCost(geminiUsage.output_text_tokens, geminiPricing.rates.output_text_micro_usd_per_million_tokens)
    + tokenCost(geminiUsage.output_audio_tokens, geminiPricing.rates.output_audio_micro_usd_per_million_tokens)
    + tokenCost(
      geminiUsage.unclassified_output_tokens,
      Math.max(
        geminiPricing.rates.output_text_micro_usd_per_million_tokens,
        geminiPricing.rates.output_audio_micro_usd_per_million_tokens,
      ),
    );

  const xaiObserved = ceilDiv(
    (xaiUsage.input_audio_micro_minutes + xaiUsage.output_audio_micro_minutes)
      * xaiPricing.rates.audio_micro_usd_per_minute,
    1_000_000,
  ) + xaiUsage.billable_text_input_events * xaiPricing.rates.text_input_micro_usd_per_event;

  const providerTurns = plan.schedule.provider_caller_turns;
  const envelope = (usageMultiplierPpm: number): CostEnvelope => {
    const provider_micro_usd = Object.freeze({
      openai: ceilProductDiv(
        [openAiObserved, providerTurns, usageMultiplierPpm],
        [openAiUsage.observed_caller_turns, 1_000_000],
      ),
      gemini: ceilProductDiv(
        [geminiObserved, providerTurns, usageMultiplierPpm],
        [geminiUsage.observed_caller_turns, 1_000_000],
      ),
      xai: ceilProductDiv(
        [xaiObserved, providerTurns, usageMultiplierPpm],
        [xaiUsage.observed_caller_turns, 1_000_000],
      ),
    });
    return Object.freeze({
      usage_multiplier_ppm: usageMultiplierPpm,
      provider_micro_usd,
      total_micro_usd: provider_micro_usd.openai + provider_micro_usd.gemini + provider_micro_usd.xai,
    });
  };
  return Object.freeze({
    low: envelope(plan.envelope_policy.low_multiplier_ppm),
    nominal: envelope(plan.envelope_policy.nominal_multiplier_ppm),
    stress: envelope(plan.envelope_policy.stress_multiplier_ppm),
  });
}

export function assertLc4CostUnderSchedulingCeiling(
  envelopes: ReturnType<typeof calculateLc4CostEnvelopes>,
  schedulingCeilingMicroUsd = LC4_COST_PLAN_SCHEDULING_CEILING_MICRO_USD,
): void {
  if (!Number.isSafeInteger(schedulingCeilingMicroUsd) || schedulingCeilingMicroUsd < 0) {
    throw new Error("LC4 scheduling ceiling is invalid");
  }
  if (envelopes.stress.total_micro_usd > schedulingCeilingMicroUsd) {
    throw new Error("LC4 stress envelope exceeds the $900 scheduling ceiling");
  }
}

function utcDay(date: string): number {
  const milliseconds = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(milliseconds)) throw new Error(`invalid date ${date}`);
  return Math.floor(milliseconds / 86_400_000);
}

export function verifyLc4ProviderCostPlan(
  input: unknown,
  options: Readonly<{ asOfDate: string }>,
): Readonly<{
  status: "verified_under_scheduling_ceiling";
  artifact_sha256: string;
  aggregate_usage_sha256: string;
  pricing_age_days: number;
  envelopes: ReturnType<typeof calculateLc4CostEnvelopes>;
}> {
  const plan = Lc4ProviderCostPlanSchema.parse(input);
  DateSchema.parse(options.asOfDate);
  const pricingDates = plan.pricing.map((entry) => entry.source.accessed_on);
  if (new Set(pricingDates).size !== 1 || pricingDates[0] !== plan.created_on) {
    throw new Error("LC4 pricing sources do not share the artifact creation date");
  }
  const pricingAgeDays = utcDay(options.asOfDate) - utcDay(pricingDates[0]!);
  if (pricingAgeDays < 0 || pricingAgeDays > plan.limits.pricing_max_age_days) {
    throw new Error(`LC4 pricing snapshot is stale or future-dated (${pricingAgeDays} days)`);
  }
  const officialSources = [
    "https://developers.openai.com/api/docs/models/gpt-realtime-2.1",
    "https://ai.google.dev/gemini-api/docs/pricing",
    "https://docs.x.ai/developers/models/voice-agent-api",
  ];
  if (plan.pricing.some((entry, index) => entry.source.url !== officialSources[index])) {
    throw new Error("LC4 pricing source is not the pinned first-party source");
  }
  const aggregateUsageSha256 = lc4AggregateUsageSha256(plan);
  if (aggregateUsageSha256 !== plan.retained_development_source.aggregate_usage_sha256) {
    throw new Error("LC4 retained aggregate usage hash mismatch");
  }
  const envelopes = calculateLc4CostEnvelopes(plan);
  if (canonicalJson(envelopes) !== canonicalJson(plan.envelopes)) {
    throw new Error("LC4 declared cost envelopes do not reproduce from pricing and retained usage");
  }
  assertLc4CostUnderSchedulingCeiling(envelopes, plan.limits.scheduling_ceiling_micro_usd);
  return Object.freeze({
    status: "verified_under_scheduling_ceiling" as const,
    artifact_sha256: sha256Hex(`hacc-lc4/provider-cost-plan/v1\n${canonicalJson(plan)}`),
    aggregate_usage_sha256: aggregateUsageSha256,
    pricing_age_days: pricingAgeDays,
    envelopes,
  });
}
