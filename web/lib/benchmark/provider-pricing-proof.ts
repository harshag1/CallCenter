import { z } from "zod";
import { canonicalJson, sha256Hex } from "./artifacts";

const HASH = /^[a-f0-9]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const HashSchema = z.string().regex(HASH);
const TimestampSchema = z.string().regex(TIMESTAMP).refine((value) => Number.isFinite(Date.parse(value)));
const PositiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const NonnegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const GATE_1_PROVIDER_RESERVATION_MICRO_USD = 5_000_000 as const;
export const MAX_PRICING_SNAPSHOT_VALIDITY_MS = 7 * 24 * 60 * 60 * 1_000;

const OPENAI_PRICING_URL = "https://developers.openai.com/api/docs/models/gpt-realtime-2.1";
const XAI_PRICING_URL = "https://docs.x.ai/developers/models/voice-agent-api";
const GEMINI_PRICING_URL = "https://ai.google.dev/gemini-api/docs/pricing";

const SourceSchema = z.object({
  official_url: z.string().url(),
  captured_sha256: HashSchema,
  captured_byte_length: PositiveSafeInteger,
}).strict();

const OpenAiSnapshotSchema = z.object({
  schema_version: z.literal(1),
  provider: z.literal("openai"),
  model: z.literal("gpt-realtime-2.1"),
  currency: z.literal("USD"),
  verified_at: TimestampSchema,
  not_after: TimestampSchema,
  source: SourceSchema.extend({ official_url: z.literal(OPENAI_PRICING_URL) }),
  rates: z.object({
    input_text_micro_usd_per_million_tokens: z.literal(4_000_000),
    input_audio_micro_usd_per_million_tokens: z.literal(32_000_000),
    output_text_micro_usd_per_million_tokens: z.literal(24_000_000),
    output_audio_micro_usd_per_million_tokens: z.literal(64_000_000),
  }).strict(),
}).strict();

const XaiSnapshotSchema = z.object({
  schema_version: z.literal(1),
  provider: z.literal("xai"),
  model: z.literal("grok-voice-think-fast-1.0"),
  currency: z.literal("USD"),
  verified_at: TimestampSchema,
  not_after: TimestampSchema,
  source: SourceSchema.extend({ official_url: z.literal(XAI_PRICING_URL) }),
  rates: z.object({
    sent_audio_micro_usd_per_minute: z.literal(50_000),
    received_audio_micro_usd_per_minute: z.literal(50_000),
    billable_text_event_micro_usd: z.literal(4_000),
    function_call_output_event_micro_usd: z.literal(0),
    response_create_event_micro_usd: z.literal(0),
  }).strict(),
}).strict();

const GeminiSnapshotSchema = z.object({
  schema_version: z.literal(1),
  provider: z.literal("gemini"),
  model: z.literal("gemini-3.1-flash-live-preview"),
  currency: z.literal("USD"),
  verified_at: TimestampSchema,
  not_after: TimestampSchema,
  source: SourceSchema.extend({ official_url: z.literal(GEMINI_PRICING_URL) }),
  rates: z.object({
    input_text_micro_usd_per_million_tokens: z.literal(750_000),
    input_audio_micro_usd_per_million_tokens: z.literal(3_000_000),
    output_text_micro_usd_per_million_tokens: z.literal(4_500_000),
    output_audio_micro_usd_per_million_tokens: z.literal(12_000_000),
  }).strict(),
}).strict();

export const ProviderPricingSnapshotSchema = z.discriminatedUnion("provider", [
  OpenAiSnapshotSchema,
  XaiSnapshotSchema,
  GeminiSnapshotSchema,
]);

const CommonCapsShape = {
  schema_version: z.literal(1),
  max_session_ms: PositiveSafeInteger.max(15 * 60_000),
  forced_close_lead_ms: PositiveSafeInteger.max(60_000),
  meter_poll_interval_ms: PositiveSafeInteger.max(5_000),
  max_input_audio_bytes: PositiveSafeInteger,
  max_output_audio_bytes: PositiveSafeInteger,
  max_tool_calls: PositiveSafeInteger.max(100_000),
  max_response_generations: PositiveSafeInteger.max(10_000),
  provider_connection_attempts: z.literal(1),
  application_retries: z.literal(0),
  provider_native_resumption: z.literal("disabled"),
  provider_transcription: z.object({
    input: z.literal("disabled"),
    output: z.literal("disabled"),
  }).strict(),
  close_on_missing_usage: z.literal(true),
  close_on_cap_reached: z.literal(true),
} as const;

const OpenAiCapsSchema = z.object({
  ...CommonCapsShape,
  provider: z.literal("openai"),
  max_billed_input_text_tokens: PositiveSafeInteger.max(128_000 * 10_000),
  max_billed_input_audio_tokens: PositiveSafeInteger.max(128_000 * 10_000),
  max_billed_output_text_tokens: PositiveSafeInteger.max(32_000 * 10_000),
  max_billed_output_audio_tokens: PositiveSafeInteger.max(128_000 * 10_000),
  max_unreported_input_text_tokens: PositiveSafeInteger,
  max_unreported_input_audio_tokens: PositiveSafeInteger,
  max_unreported_output_text_tokens: PositiveSafeInteger,
  max_unreported_output_audio_tokens: PositiveSafeInteger,
}).strict();

const XaiCapsSchema = z.object({
  ...CommonCapsShape,
  provider: z.literal("xai"),
  max_sent_audio_ms: PositiveSafeInteger,
  max_received_audio_ms: PositiveSafeInteger,
  max_billable_text_events: NonnegativeSafeInteger.max(100_000),
  max_unreported_sent_audio_ms: PositiveSafeInteger,
  max_unreported_received_audio_ms: PositiveSafeInteger,
  max_unreported_billable_text_events: NonnegativeSafeInteger.max(100_000),
}).strict();

const GeminiCapsSchema = z.object({
  ...CommonCapsShape,
  provider: z.literal("gemini"),
  max_billed_input_text_tokens: PositiveSafeInteger.max(1_000_000 * 10_000),
  max_billed_input_audio_tokens: PositiveSafeInteger.max(1_000_000 * 10_000),
  max_billed_output_text_tokens: PositiveSafeInteger.max(64_000 * 10_000),
  max_billed_output_audio_tokens: PositiveSafeInteger.max(1_000_000 * 10_000),
  max_unreported_input_text_tokens: PositiveSafeInteger,
  max_unreported_input_audio_tokens: PositiveSafeInteger,
  max_unreported_output_text_tokens: PositiveSafeInteger,
  max_unreported_output_audio_tokens: PositiveSafeInteger,
}).strict();

export const ProviderHardSessionCapsSchema = z.discriminatedUnion("provider", [
  OpenAiCapsSchema,
  XaiCapsSchema,
  GeminiCapsSchema,
]).superRefine((caps, context) => {
  if (caps.forced_close_lead_ms >= caps.max_session_ms) {
    context.addIssue({
      code: "custom",
      path: ["forced_close_lead_ms"],
      message: "forced close lead must leave a positive session window",
    });
  }
  if (caps.max_input_audio_bytes % 2 !== 0 || caps.max_output_audio_bytes % 2 !== 0) {
    context.addIssue({
      code: "custom",
      path: ["max_input_audio_bytes"],
      message: "PCM16 byte caps must be even",
    });
  }
  if (caps.provider === "xai") {
    if (caps.max_sent_audio_ms > caps.max_session_ms || caps.max_received_audio_ms > caps.max_session_ms) {
      context.addIssue({ code: "custom", path: ["max_sent_audio_ms"], message: "xAI audio meter caps cannot exceed the session cap" });
    }
    if (
      caps.max_unreported_sent_audio_ms > caps.max_sent_audio_ms
      || caps.max_unreported_received_audio_ms > caps.max_received_audio_ms
      || caps.max_unreported_billable_text_events > caps.max_billable_text_events
    ) {
      context.addIssue({
        code: "custom",
        path: ["max_unreported_sent_audio_ms"],
        message: "xAI unreported meter lag cannot exceed the total cap",
      });
    }
  } else {
    for (const key of [
      "max_billed_input_text_tokens",
      "max_billed_input_audio_tokens",
      "max_billed_output_text_tokens",
      "max_billed_output_audio_tokens",
    ] as const) {
      const lagKey = key.replace("max_billed_", "max_unreported_") as
        | "max_unreported_input_text_tokens"
        | "max_unreported_input_audio_tokens"
        | "max_unreported_output_text_tokens"
        | "max_unreported_output_audio_tokens";
      if (caps[lagKey] > caps[key]) {
        context.addIssue({ code: "custom", path: [lagKey], message: "unreported meter lag cannot exceed the total cap" });
      }
    }
  }
});

const LineItemSchema = z.object({
  meter: z.enum([
    "input_text_tokens",
    "input_audio_tokens",
    "output_text_tokens",
    "output_audio_tokens",
    "sent_audio_ms",
    "received_audio_ms",
    "billable_text_events",
  ]),
  upper_bound_units: NonnegativeSafeInteger,
  rate_micro_usd_numerator: NonnegativeSafeInteger,
  rate_units_denominator: PositiveSafeInteger,
  upper_bound_micro_usd: NonnegativeSafeInteger,
}).strict();

const DerivedProofSchema = z.object({
  schema_version: z.literal(1),
  provider: z.enum(["openai", "xai", "gemini"]),
  model: z.string().min(1),
  pricing_snapshot_sha256: HashSchema,
  hard_session_caps_sha256: HashSchema,
  formula_id: z.enum([
    "openai.realtime_token_upper_bound.v1",
    "xai.voice_duration_event_upper_bound.v1",
    "gemini.live_token_upper_bound.v1",
  ]),
  formula_sha256: HashSchema,
  line_items: z.array(LineItemSchema).min(3).max(4),
  metered_upper_bound_micro_usd: NonnegativeSafeInteger,
  worst_unreported_meter_lag_micro_usd: NonnegativeSafeInteger,
  safety_margin_micro_usd: NonnegativeSafeInteger,
  conservative_liability_micro_usd: PositiveSafeInteger,
  reservation_micro_usd: z.literal(GATE_1_PROVIDER_RESERVATION_MICRO_USD),
  reservation_headroom_micro_usd: NonnegativeSafeInteger,
  enforcement: z.object({
    pre_client_verification_required: z.literal(true),
    one_connection_attempt_consumes_frozen_slot: z.literal(true),
    pre_client_failure_consumes_attempt: z.literal(false),
    retry_allowed: z.literal(false),
    forced_close_before_reservation_exhaustion: z.literal(true),
    usage_meter_required: z.literal(true),
  }).strict(),
}).strict();

const PricingProofBodySchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal("hacc_provider_gate1_pricing_proof"),
  snapshot: ProviderPricingSnapshotSchema,
  caps: ProviderHardSessionCapsSchema,
  safety_margin_micro_usd: NonnegativeSafeInteger,
  derived: DerivedProofSchema,
  verified: z.literal(true),
}).strict();

export const ProviderPricingProofSchema = PricingProofBodySchema.extend({
  proof_sha256: HashSchema,
}).strict();

export type ProviderPricingSnapshot = z.infer<typeof ProviderPricingSnapshotSchema>;
export type ProviderHardSessionCaps = z.infer<typeof ProviderHardSessionCapsSchema>;
export type ProviderPricingProof = z.infer<typeof ProviderPricingProofSchema>;

export type ProviderPricingCostEnvelope = Readonly<{
  pricing_snapshot_sha256: string;
  limits_sha256: string;
  formula_sha256: string;
  components: readonly Readonly<{
    name: string;
    upper_bound_micro_usd: number;
  }>[];
  safety_margin_micro_usd: number;
}>;

export class ProviderPricingProofError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ProviderPricingProofError";
  }
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= BigInt(0)) throw new ProviderPricingProofError("arithmetic", "pricing denominator must be positive");
  return (numerator + denominator - BigInt(1)) / denominator;
}

function boundedCost(units: number, numerator: number, denominator: number): number {
  const result = ceilDiv(BigInt(units) * BigInt(numerator), BigInt(denominator));
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ProviderPricingProofError("arithmetic", "pricing result exceeds safe integer range");
  }
  return Number(result);
}

function lineItem(
  meter: z.infer<typeof LineItemSchema>["meter"],
  units: number,
  numerator: number,
  denominator: number
): z.infer<typeof LineItemSchema> {
  return Object.freeze({
    meter,
    upper_bound_units: units,
    rate_micro_usd_numerator: numerator,
    rate_units_denominator: denominator,
    upper_bound_micro_usd: boundedCost(units, numerator, denominator),
  });
}

function assertFreshSnapshot(snapshot: ProviderPricingSnapshot, now: Date): void {
  const verifiedAt = Date.parse(snapshot.verified_at);
  const notAfter = Date.parse(snapshot.not_after);
  if (notAfter <= verifiedAt || notAfter - verifiedAt > MAX_PRICING_SNAPSHOT_VALIDITY_MS) {
    throw new ProviderPricingProofError("snapshot_window", "pricing snapshot validity window is invalid or exceeds seven days");
  }
  if (verifiedAt > now.getTime() + 5 * 60_000) {
    throw new ProviderPricingProofError("snapshot_future", "pricing snapshot verification time is in the future");
  }
  if (now.getTime() >= notAfter) {
    throw new ProviderPricingProofError("snapshot_stale", "pricing snapshot has expired");
  }
}

export function providerPricingSnapshotSha256(snapshot: ProviderPricingSnapshot): string {
  return sha256Hex(`hacc/provider-pricing-snapshot/v1\n${canonicalJson(ProviderPricingSnapshotSchema.parse(snapshot))}`);
}

export function providerHardSessionCapsSha256(caps: ProviderHardSessionCaps): string {
  return sha256Hex(`hacc/provider-hard-session-caps/v1\n${canonicalJson(ProviderHardSessionCapsSchema.parse(caps))}`);
}

function formulaSha256(snapshot: ProviderPricingSnapshot): string {
  return sha256Hex(`hacc/provider-pricing-formula/v1\n${canonicalJson({
    provider: snapshot.provider,
    model: snapshot.model,
    rates: snapshot.rates,
  })}`);
}

function derive(input: Readonly<{
  snapshot: ProviderPricingSnapshot;
  caps: ProviderHardSessionCaps;
  safetyMarginMicroUsd: number;
}>): z.infer<typeof DerivedProofSchema> {
  if (input.snapshot.provider !== input.caps.provider) {
    throw new ProviderPricingProofError("provider_mismatch", "pricing snapshot and hard caps name different providers");
  }
  const lineItems: z.infer<typeof LineItemSchema>[] = [];
  const lagItems: z.infer<typeof LineItemSchema>[] = [];
  let formulaId: z.infer<typeof DerivedProofSchema>["formula_id"];
  if (input.snapshot.provider === "openai" && input.caps.provider === "openai") {
    formulaId = "openai.realtime_token_upper_bound.v1";
    const rates = input.snapshot.rates;
    lineItems.push(
      lineItem("input_text_tokens", input.caps.max_billed_input_text_tokens, rates.input_text_micro_usd_per_million_tokens, 1_000_000),
      lineItem("input_audio_tokens", input.caps.max_billed_input_audio_tokens, rates.input_audio_micro_usd_per_million_tokens, 1_000_000),
      lineItem("output_text_tokens", input.caps.max_billed_output_text_tokens, rates.output_text_micro_usd_per_million_tokens, 1_000_000),
      lineItem("output_audio_tokens", input.caps.max_billed_output_audio_tokens, rates.output_audio_micro_usd_per_million_tokens, 1_000_000)
    );
    lagItems.push(
      lineItem("input_text_tokens", input.caps.max_unreported_input_text_tokens, rates.input_text_micro_usd_per_million_tokens, 1_000_000),
      lineItem("input_audio_tokens", input.caps.max_unreported_input_audio_tokens, rates.input_audio_micro_usd_per_million_tokens, 1_000_000),
      lineItem("output_text_tokens", input.caps.max_unreported_output_text_tokens, rates.output_text_micro_usd_per_million_tokens, 1_000_000),
      lineItem("output_audio_tokens", input.caps.max_unreported_output_audio_tokens, rates.output_audio_micro_usd_per_million_tokens, 1_000_000)
    );
  } else if (input.snapshot.provider === "xai" && input.caps.provider === "xai") {
    formulaId = "xai.voice_duration_event_upper_bound.v1";
    const rates = input.snapshot.rates;
    lineItems.push(
      lineItem("sent_audio_ms", input.caps.max_sent_audio_ms, rates.sent_audio_micro_usd_per_minute, 60_000),
      lineItem("received_audio_ms", input.caps.max_received_audio_ms, rates.received_audio_micro_usd_per_minute, 60_000),
      lineItem("billable_text_events", input.caps.max_billable_text_events, rates.billable_text_event_micro_usd, 1)
    );
    lagItems.push(
      lineItem("sent_audio_ms", input.caps.max_unreported_sent_audio_ms, rates.sent_audio_micro_usd_per_minute, 60_000),
      lineItem("received_audio_ms", input.caps.max_unreported_received_audio_ms, rates.received_audio_micro_usd_per_minute, 60_000),
      lineItem("billable_text_events", input.caps.max_unreported_billable_text_events, rates.billable_text_event_micro_usd, 1)
    );
  } else if (input.snapshot.provider === "gemini" && input.caps.provider === "gemini") {
    formulaId = "gemini.live_token_upper_bound.v1";
    const rates = input.snapshot.rates;
    lineItems.push(
      lineItem("input_text_tokens", input.caps.max_billed_input_text_tokens, rates.input_text_micro_usd_per_million_tokens, 1_000_000),
      lineItem("input_audio_tokens", input.caps.max_billed_input_audio_tokens, rates.input_audio_micro_usd_per_million_tokens, 1_000_000),
      lineItem("output_text_tokens", input.caps.max_billed_output_text_tokens, rates.output_text_micro_usd_per_million_tokens, 1_000_000),
      lineItem("output_audio_tokens", input.caps.max_billed_output_audio_tokens, rates.output_audio_micro_usd_per_million_tokens, 1_000_000)
    );
    lagItems.push(
      lineItem("input_text_tokens", input.caps.max_unreported_input_text_tokens, rates.input_text_micro_usd_per_million_tokens, 1_000_000),
      lineItem("input_audio_tokens", input.caps.max_unreported_input_audio_tokens, rates.input_audio_micro_usd_per_million_tokens, 1_000_000),
      lineItem("output_text_tokens", input.caps.max_unreported_output_text_tokens, rates.output_text_micro_usd_per_million_tokens, 1_000_000),
      lineItem("output_audio_tokens", input.caps.max_unreported_output_audio_tokens, rates.output_audio_micro_usd_per_million_tokens, 1_000_000)
    );
  } else {
    throw new ProviderPricingProofError("provider_mismatch", "unsupported provider pricing pair");
  }
  const metered = lineItems.reduce((sum, item) => sum + item.upper_bound_micro_usd, 0);
  const lag = lagItems.reduce((sum, item) => sum + item.upper_bound_micro_usd, 0);
  if (input.safetyMarginMicroUsd < lag) {
    throw new ProviderPricingProofError("meter_lag_uncovered", "safety margin does not cover the worst unreported meter lag");
  }
  const liability = metered + input.safetyMarginMicroUsd;
  if (liability <= 0 || liability > GATE_1_PROVIDER_RESERVATION_MICRO_USD) {
    throw new ProviderPricingProofError("reservation_exceeded", "conservative provider liability exceeds the exact $5 reservation");
  }
  return DerivedProofSchema.parse({
    schema_version: 1,
    provider: input.snapshot.provider,
    model: input.snapshot.model,
    pricing_snapshot_sha256: providerPricingSnapshotSha256(input.snapshot),
    hard_session_caps_sha256: providerHardSessionCapsSha256(input.caps),
    formula_id: formulaId,
    formula_sha256: formulaSha256(input.snapshot),
    line_items: lineItems,
    metered_upper_bound_micro_usd: metered,
    worst_unreported_meter_lag_micro_usd: lag,
    safety_margin_micro_usd: input.safetyMarginMicroUsd,
    conservative_liability_micro_usd: liability,
    reservation_micro_usd: GATE_1_PROVIDER_RESERVATION_MICRO_USD,
    reservation_headroom_micro_usd: GATE_1_PROVIDER_RESERVATION_MICRO_USD - liability,
    enforcement: {
      pre_client_verification_required: true,
      one_connection_attempt_consumes_frozen_slot: true,
      pre_client_failure_consumes_attempt: false,
      retry_allowed: false,
      forced_close_before_reservation_exhaustion: true,
      usage_meter_required: true,
    },
  });
}

function proofSha256(body: z.infer<typeof PricingProofBodySchema>): string {
  return sha256Hex(`hacc/provider-gate1-pricing-proof/v1\n${canonicalJson(PricingProofBodySchema.parse(body))}`);
}

function buildProviderPricingProof(input: Readonly<{
  snapshot: ProviderPricingSnapshot;
  caps: ProviderHardSessionCaps;
  safetyMarginMicroUsd: number;
  now: Date;
}>): ProviderPricingProof {
  assertFreshSnapshot(input.snapshot, input.now);
  const safetyMarginMicroUsd = NonnegativeSafeInteger.parse(input.safetyMarginMicroUsd);
  const derived = derive({
    snapshot: input.snapshot,
    caps: input.caps,
    safetyMarginMicroUsd,
  });
  const body = PricingProofBodySchema.parse({
    schema_version: 1,
    kind: "hacc_provider_gate1_pricing_proof",
    snapshot: input.snapshot,
    caps: input.caps,
    safety_margin_micro_usd: safetyMarginMicroUsd,
    derived,
    verified: true,
  });
  return ProviderPricingProofSchema.parse({ ...body, proof_sha256: proofSha256(body) });
}

export function createProviderPricingProof(input: Readonly<{
  snapshot: unknown;
  caps: unknown;
  safetyMarginMicroUsd: number;
  sourceCapture: string | Uint8Array;
  now?: Date;
}>): ProviderPricingProof {
  const snapshot = ProviderPricingSnapshotSchema.parse(input.snapshot);
  const caps = ProviderHardSessionCapsSchema.parse(input.caps);
  const sourceCapture = typeof input.sourceCapture === "string"
    ? Buffer.from(input.sourceCapture, "utf8")
    : Buffer.from(input.sourceCapture);
  if (
    snapshot.source.captured_sha256 !== sha256Hex(sourceCapture)
    || snapshot.source.captured_byte_length !== sourceCapture.byteLength
  ) {
    throw new ProviderPricingProofError("source_capture_mismatch", "official pricing source capture differs from its snapshot binding");
  }
  return buildProviderPricingProof({
    snapshot,
    caps,
    safetyMarginMicroUsd: input.safetyMarginMicroUsd,
    now: input.now ?? new Date(),
  });
}

export function serializeProviderPricingProof(proof: ProviderPricingProof): string {
  const parsed = ProviderPricingProofSchema.parse(proof);
  const { proof_sha256: _proofSha256, ...body } = parsed;
  void _proofSha256;
  if (proofSha256(body) !== parsed.proof_sha256) {
    throw new ProviderPricingProofError("proof_hash_mismatch", "provider pricing proof hash is invalid");
  }
  return `${canonicalJson(parsed)}\n`;
}

export function parseCanonicalProviderPricingProof(bytes: string | Uint8Array): ProviderPricingProof {
  const text = typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8");
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n") || text.includes("\r") || text.includes("\0")) {
    throw new ProviderPricingProofError("noncanonical", "provider pricing proof must be one canonical JSON object and newline");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProviderPricingProofError("invalid_json", "provider pricing proof JSON is invalid");
  }
  if (`${canonicalJson(value)}\n` !== text) {
    throw new ProviderPricingProofError("noncanonical", "provider pricing proof JSON is not canonical");
  }
  const parsed = ProviderPricingProofSchema.parse(value);
  const { proof_sha256: _proofSha256, ...body } = parsed;
  void _proofSha256;
  if (proofSha256(body) !== parsed.proof_sha256) {
    throw new ProviderPricingProofError("proof_hash_mismatch", "provider pricing proof hash mismatch");
  }
  return parsed;
}

export function verifyProviderPricingProof(input: Readonly<{
  proof: unknown;
  sourceCapture: string | Uint8Array;
  now?: Date;
}>): Readonly<{ valid: boolean; errors: readonly string[]; proof: ProviderPricingProof | null }> {
  try {
    const parsed = ProviderPricingProofSchema.parse(input.proof);
    const sourceCapture = typeof input.sourceCapture === "string"
      ? Buffer.from(input.sourceCapture, "utf8")
      : Buffer.from(input.sourceCapture);
    if (
      parsed.snapshot.source.captured_sha256 !== sha256Hex(sourceCapture)
      || parsed.snapshot.source.captured_byte_length !== sourceCapture.byteLength
    ) {
      throw new ProviderPricingProofError("source_capture_mismatch", "official pricing source capture differs from its snapshot binding");
    }
    const recomputed = buildProviderPricingProof({
      snapshot: parsed.snapshot,
      caps: parsed.caps,
      safetyMarginMicroUsd: parsed.safety_margin_micro_usd,
      now: input.now ?? new Date(),
    });
    const valid = canonicalJson(recomputed) === canonicalJson(parsed);
    return Object.freeze({
      valid,
      errors: Object.freeze(valid ? [] : ["proof_not_derived"]),
      proof: valid ? parsed : null,
    });
  } catch (error) {
    const code = error instanceof ProviderPricingProofError ? error.code : "proof_invalid";
    return Object.freeze({ valid: false, errors: Object.freeze([code]), proof: null });
  }
}

export function verifyProviderPricingProofStructure(input: Readonly<{
  proof: unknown;
  now?: Date;
}>): Readonly<{ valid: boolean; errors: readonly string[]; proof: ProviderPricingProof | null }> {
  try {
    const parsed = ProviderPricingProofSchema.parse(input.proof);
    const recomputed = buildProviderPricingProof({
      snapshot: parsed.snapshot,
      caps: parsed.caps,
      safetyMarginMicroUsd: parsed.safety_margin_micro_usd,
      now: input.now ?? new Date(),
    });
    const valid = canonicalJson(recomputed) === canonicalJson(parsed);
    return Object.freeze({
      valid,
      errors: Object.freeze(valid ? [] : ["proof_not_derived"]),
      proof: valid ? parsed : null,
    });
  } catch (error) {
    const code = error instanceof ProviderPricingProofError ? error.code : "proof_invalid";
    return Object.freeze({ valid: false, errors: Object.freeze([code]), proof: null });
  }
}

/**
 * Produces the only cost-envelope decomposition accepted by paid execution.
 * The reservation headroom is explicit rather than disguised as provider
 * usage, so the filesystem ledger reserves exactly $5 while the evidence
 * preserves the proof's actual metered bound and safety margin.
 */
export function providerPricingProofCostEnvelope(
  input: ProviderPricingProof,
  limitsSha256: string,
): ProviderPricingCostEnvelope {
  const proof = ProviderPricingProofSchema.parse(input);
  if (!HASH.test(limitsSha256)) {
    throw new ProviderPricingProofError("limits_hash_invalid", "paid limits hash is invalid");
  }
  const components: Array<Readonly<{
    name: string;
    upper_bound_micro_usd: number;
  }>> = proof.derived.line_items
    .filter((item) => item.upper_bound_micro_usd > 0)
    .map((item) => Object.freeze({
      name: `meter.${item.meter}`,
      upper_bound_micro_usd: item.upper_bound_micro_usd,
    }));
  if (proof.derived.reservation_headroom_micro_usd > 0) {
    components.push(Object.freeze({
      name: "reservation.headroom",
      upper_bound_micro_usd: proof.derived.reservation_headroom_micro_usd,
    }));
  }
  return Object.freeze({
    pricing_snapshot_sha256: proof.derived.pricing_snapshot_sha256,
    limits_sha256: limitsSha256,
    formula_sha256: proof.derived.formula_sha256,
    components: Object.freeze(components),
    safety_margin_micro_usd: proof.safety_margin_micro_usd,
  });
}

export const PROVIDER_PRICING_OFFICIAL_URLS = Object.freeze({
  openai: OPENAI_PRICING_URL,
  xai: XAI_PRICING_URL,
  gemini: GEMINI_PRICING_URL,
});
