import { describe, expect, it } from "vitest";
import { sha256Hex } from "../artifacts";
import {
  GATE_1_PROVIDER_RESERVATION_MICRO_USD,
  PROVIDER_PRICING_OFFICIAL_URLS,
  createProviderPricingProof,
  parseCanonicalProviderPricingProof,
  providerPricingProofCostEnvelope,
  serializeProviderPricingProof,
  verifyProviderPricingProof,
} from "../provider-pricing-proof";

const NOW = new Date("2026-07-16T20:00:00.000Z");

function source(provider: "openai" | "xai" | "gemini") {
  const capture = `Official ${provider} pricing capture for deterministic unit test.`;
  return {
    capture,
    binding: {
      official_url: PROVIDER_PRICING_OFFICIAL_URLS[provider],
      captured_sha256: sha256Hex(capture),
      captured_byte_length: Buffer.byteLength(capture),
    },
  };
}

const commonCaps = {
  schema_version: 1 as const,
  max_session_ms: 30_000,
  forced_close_lead_ms: 2_000,
  meter_poll_interval_ms: 250,
  max_input_audio_bytes: 1_440_000,
  max_output_audio_bytes: 1_440_000,
  max_tool_calls: 32,
  max_response_generations: 4,
  provider_connection_attempts: 1 as const,
  application_retries: 0 as const,
  provider_native_resumption: "disabled" as const,
  provider_transcription: { input: "disabled" as const, output: "disabled" as const },
  close_on_missing_usage: true as const,
  close_on_cap_reached: true as const,
};

function openaiFixture() {
  const pricingSource = source("openai");
  return {
    sourceCapture: pricingSource.capture,
    safetyMarginMicroUsd: 100_000,
    snapshot: {
      schema_version: 1,
      provider: "openai",
      model: "gpt-realtime-2.1",
      currency: "USD",
      verified_at: "2026-07-16T19:00:00.000Z",
      not_after: "2026-07-17T19:00:00.000Z",
      source: pricingSource.binding,
      rates: {
        input_text_micro_usd_per_million_tokens: 4_000_000,
        input_audio_micro_usd_per_million_tokens: 32_000_000,
        output_text_micro_usd_per_million_tokens: 24_000_000,
        output_audio_micro_usd_per_million_tokens: 64_000_000,
      },
    },
    caps: {
      ...commonCaps,
      provider: "openai",
      max_billed_input_text_tokens: 65_536,
      max_billed_input_audio_tokens: 4_096,
      max_billed_output_text_tokens: 16_384,
      max_billed_output_audio_tokens: 4_096,
      max_unreported_input_text_tokens: 64,
      max_unreported_input_audio_tokens: 64,
      max_unreported_output_text_tokens: 64,
      max_unreported_output_audio_tokens: 64,
    },
  };
}

function xaiFixture() {
  const pricingSource = source("xai");
  return {
    sourceCapture: pricingSource.capture,
    safetyMarginMicroUsd: 10_000,
    snapshot: {
      schema_version: 1,
      provider: "xai",
      model: "grok-voice-think-fast-1.0",
      currency: "USD",
      verified_at: "2026-07-16T19:00:00.000Z",
      not_after: "2026-07-17T19:00:00.000Z",
      source: pricingSource.binding,
      rates: {
        sent_audio_micro_usd_per_minute: 50_000,
        received_audio_micro_usd_per_minute: 50_000,
        billable_text_event_micro_usd: 4_000,
        function_call_output_event_micro_usd: 0,
        response_create_event_micro_usd: 0,
      },
    },
    caps: {
      ...commonCaps,
      provider: "xai",
      max_sent_audio_ms: 30_000,
      max_received_audio_ms: 30_000,
      max_billable_text_events: 4,
      max_unreported_sent_audio_ms: 1_000,
      max_unreported_received_audio_ms: 1_000,
      max_unreported_billable_text_events: 1,
    },
  };
}

function geminiFixture() {
  const pricingSource = source("gemini");
  return {
    sourceCapture: pricingSource.capture,
    safetyMarginMicroUsd: 100_000,
    snapshot: {
      schema_version: 1,
      provider: "gemini",
      model: "gemini-3.1-flash-live-preview",
      currency: "USD",
      verified_at: "2026-07-16T19:00:00.000Z",
      not_after: "2026-07-17T19:00:00.000Z",
      source: pricingSource.binding,
      rates: {
        input_text_micro_usd_per_million_tokens: 750_000,
        input_audio_micro_usd_per_million_tokens: 3_000_000,
        output_text_micro_usd_per_million_tokens: 4_500_000,
        output_audio_micro_usd_per_million_tokens: 12_000_000,
      },
    },
    caps: {
      ...commonCaps,
      provider: "gemini",
      max_billed_input_text_tokens: 524_288,
      max_billed_input_audio_tokens: 32_768,
      max_billed_output_text_tokens: 262_144,
      max_billed_output_audio_tokens: 65_536,
      max_unreported_input_text_tokens: 128,
      max_unreported_input_audio_tokens: 128,
      max_unreported_output_text_tokens: 128,
      max_unreported_output_audio_tokens: 128,
    },
  };
}

describe("executable provider pricing proofs", () => {
  it.each([
    ["openai", openaiFixture, 1_148_576],
    ["xai", xaiFixture, 76_000],
    ["gemini", geminiFixture, 2_557_600],
  ] as const)("derives and verifies the %s exact upper bound", (_provider, fixture, expectedLiability) => {
    const input = fixture();
    const proof = createProviderPricingProof({ ...input, now: NOW });
    expect(proof.derived).toMatchObject({
      conservative_liability_micro_usd: expectedLiability,
      reservation_micro_usd: GATE_1_PROVIDER_RESERVATION_MICRO_USD,
      reservation_headroom_micro_usd: GATE_1_PROVIDER_RESERVATION_MICRO_USD - expectedLiability,
      enforcement: {
        pre_client_verification_required: true,
        one_connection_attempt_consumes_frozen_slot: true,
        pre_client_failure_consumes_attempt: false,
        retry_allowed: false,
        forced_close_before_reservation_exhaustion: true,
        usage_meter_required: true,
      },
    });
    expect(verifyProviderPricingProof({ proof, sourceCapture: input.sourceCapture, now: NOW })).toMatchObject({
      valid: true,
      errors: [],
    });
    expect(parseCanonicalProviderPricingProof(serializeProviderPricingProof(proof))).toEqual(proof);
  });

  it("derives an exact $5 ledger envelope without laundering reservation headroom as usage", () => {
    const input = openaiFixture();
    const proof = createProviderPricingProof({ ...input, now: NOW });
    const envelope = providerPricingProofCostEnvelope(proof, "a".repeat(64));
    expect(envelope.components.filter((component) => component.name.startsWith("meter."))).toEqual(
      proof.derived.line_items.map((item) => ({
        name: `meter.${item.meter}`,
        upper_bound_micro_usd: item.upper_bound_micro_usd,
      })),
    );
    expect(envelope).toMatchObject({
      safety_margin_micro_usd: proof.safety_margin_micro_usd,
      components: expect.arrayContaining([{
        name: "reservation.headroom",
        upper_bound_micro_usd: proof.derived.reservation_headroom_micro_usd,
      }]),
    });
    expect(
      envelope.components.reduce((sum, component) => sum + component.upper_bound_micro_usd, 0)
      + envelope.safety_margin_micro_usd,
    ).toBe(GATE_1_PROVIDER_RESERVATION_MICRO_USD);
  });

  it("uses ceiling arithmetic for partial xAI billing units", () => {
    const input = xaiFixture();
    const proof = createProviderPricingProof({
      ...input,
      safetyMarginMicroUsd: 2,
      caps: {
        ...input.caps,
        max_sent_audio_ms: 1,
        max_received_audio_ms: 1,
        max_billable_text_events: 0,
        max_unreported_sent_audio_ms: 1,
        max_unreported_received_audio_ms: 1,
        max_unreported_billable_text_events: 0,
      },
      now: NOW,
    });
    expect(proof.derived.line_items.map((item) => item.upper_bound_micro_usd)).toEqual([1, 1, 0]);
    expect(proof.derived.conservative_liability_micro_usd).toBe(4);
  });

  it("rejects a stale snapshot", () => {
    const input = openaiFixture();
    expect(() => createProviderPricingProof({
      ...input,
      now: new Date("2026-07-18T00:00:00.000Z"),
    })).toThrowError(/expired/);
  });

  it("rejects a source capture mismatch", () => {
    const input = xaiFixture();
    expect(() => createProviderPricingProof({
      ...input,
      sourceCapture: "different official page bytes",
      now: NOW,
    })).toThrowError(/source capture differs/);
  });

  it("rejects lower forged provider rates", () => {
    const input = geminiFixture();
    expect(() => createProviderPricingProof({
      ...input,
      snapshot: {
        ...input.snapshot,
        rates: { ...input.snapshot.rates, output_audio_micro_usd_per_million_tokens: 1 },
      },
      now: NOW,
    })).toThrow();
  });

  it("rejects provider/model formula substitution", () => {
    const openai = openaiFixture();
    const xai = xaiFixture();
    expect(() => createProviderPricingProof({
      ...openai,
      caps: xai.caps,
      now: NOW,
    })).toThrowError(/different providers/);
  });

  it("rejects retry, transcription, and multiple-connection policy relaxations", () => {
    const input = openaiFixture();
    for (const caps of [
      { ...input.caps, application_retries: 1 },
      { ...input.caps, provider_connection_attempts: 2 },
      { ...input.caps, provider_transcription: { input: "enabled", output: "disabled" } },
    ]) {
      expect(() => createProviderPricingProof({ ...input, caps, now: NOW })).toThrow();
    }
  });

  it("rejects liability above the exact $5 reservation", () => {
    const input = openaiFixture();
    expect(() => createProviderPricingProof({
      ...input,
      caps: {
        ...input.caps,
        max_billed_input_text_tokens: 1_000_000,
        max_billed_input_audio_tokens: 1_000_000,
        max_billed_output_text_tokens: 1_000_000,
        max_billed_output_audio_tokens: 1_000_000,
      },
      now: NOW,
    })).toThrowError(/exceeds the exact \$5 reservation/);
  });

  it("rejects a safety margin smaller than unreported meter exposure", () => {
    const input = geminiFixture();
    expect(() => createProviderPricingProof({
      ...input,
      safetyMarginMicroUsd: 1,
      now: NOW,
    })).toThrowError(/does not cover/);
  });

  it("rejects a rehashed derived-field mutation", () => {
    const input = xaiFixture();
    const proof = createProviderPricingProof({ ...input, now: NOW });
    const mutated = structuredClone(proof);
    mutated.derived.conservative_liability_micro_usd += 1;
    expect(verifyProviderPricingProof({ proof: mutated, sourceCapture: input.sourceCapture, now: NOW })).toMatchObject({
      valid: false,
    });
  });
});
