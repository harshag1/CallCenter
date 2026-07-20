import { describe, expect, it } from "vitest";
import {
  OPERATOR_PRICING_ENV,
  OperatorPricingError,
  assertOperatorCostQuoteUsable,
  assertVoiceQuoteCoversCurrentPricing,
  canonicalOperatorPricingJson,
  createEmailCostQuote,
  createNumberMonthlyCostQuote,
  createSmsCostQuote,
  createVoiceCampaignCostQuote,
  createVoiceCostQuote,
  operatorPricingSha256,
  parseOperatorCostQuote,
  parseUsdToMicroUsd,
  resolveVoiceMaxDurationSeconds,
  type OperatorPricingEnvironment,
} from "../operator-pricing";

const NOW = new Date("2026-07-16T20:00:00.000Z");

function environment(overrides: OperatorPricingEnvironment = {}): OperatorPricingEnvironment {
  return Object.freeze({
    [OPERATOR_PRICING_ENV.emailSendCeilingUsd]: "0.002500",
    [OPERATOR_PRICING_ENV.smsSegmentCeilingUsd]: "0.012345",
    [OPERATOR_PRICING_ENV.voiceMinuteCeilingUsd]: "0.125",
    [OPERATOR_PRICING_ENV.numberMonthlyCeilingUsd]: "2.50",
    [OPERATOR_PRICING_ENV.callMaxDurationSeconds]: "900",
    [OPERATOR_PRICING_ENV.safetyMarginUsd]: "0.000010",
    [OPERATOR_PRICING_ENV.quoteTtlSeconds]: "300",
    [OPERATOR_PRICING_ENV.maxReservationUsd]: "100",
    ...overrides,
  });
}

function errorCode(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof OperatorPricingError ? error.code : undefined;
  }
}

describe("operator pricing", () => {
  it("parses exact decimal USD without floating-point rounding", () => {
    expect(parseUsdToMicroUsd("0")).toBe(0);
    expect(parseUsdToMicroUsd("0.000001")).toBe(1);
    expect(parseUsdToMicroUsd("1.234567")).toBe(1_234_567);
    expect(parseUsdToMicroUsd("9007199254.740991")).toBe(Number.MAX_SAFE_INTEGER);

    for (const invalid of [
      "",
      " 1",
      "1 ",
      "+1",
      "-1",
      "01",
      "1.",
      ".1",
      "1e2",
      "0.0000001",
      "9007199254.740992",
    ]) {
      expect(errorCode(() => parseUsdToMicroUsd(invalid))).toBe("invalid_amount");
    }
  });

  it("produces stable domain-separated canonical hashes", () => {
    const first = { z: [3, { b: true, a: "x" }], a: 1 } as const;
    const reordered = { a: 1, z: [3, { a: "x", b: true }] } as const;

    expect(canonicalOperatorPricingJson(first)).toBe(canonicalOperatorPricingJson(reordered));
    expect(operatorPricingSha256("test-domain", first)).toBe(operatorPricingSha256("test-domain", reordered));
    expect(operatorPricingSha256("test-domain", first)).toMatch(/^[a-f0-9]{64}$/);
    expect(operatorPricingSha256("other-domain", first)).not.toBe(operatorPricingSha256("test-domain", first));
    expect(operatorPricingSha256("test-domain", [1, 2])).not.toBe(operatorPricingSha256("test-domain", [2, 1]));
  });

  it("fails closed for missing, malformed, zero, and unsafe configuration", () => {
    const missingMargin = { ...environment() };
    delete missingMargin[OPERATOR_PRICING_ENV.safetyMarginUsd];
    expect(errorCode(() => createEmailCostQuote(
      { recipient: "person@example.test" },
      { environment: missingMargin, now: NOW }
    ))).toBe("invalid_configuration");

    expect(errorCode(() => createEmailCostQuote(
      { recipient: "person@example.test" },
      { environment: environment({ [OPERATOR_PRICING_ENV.emailSendCeilingUsd]: "0" }), now: NOW }
    ))).toBe("invalid_configuration");
    expect(errorCode(() => createEmailCostQuote(
      { recipient: "person@example.test" },
      { environment: environment({ [OPERATOR_PRICING_ENV.maxReservationUsd]: "1e3" }), now: NOW }
    ))).toBe("invalid_configuration");
    expect(errorCode(() => createEmailCostQuote(
      { recipient: "person@example.test" },
      { environment: environment({ [OPERATOR_PRICING_ENV.quoteTtlSeconds]: "86401" }), now: NOW }
    ))).toBe("invalid_configuration");
  });

  it("creates an immutable email quote bound to the exact recipient", () => {
    const quote = createEmailCostQuote(
      { recipient: "person@example.test" },
      { environment: environment(), now: NOW }
    );
    const otherRecipient = createEmailCostQuote(
      { recipient: "other@example.test" },
      { environment: environment(), now: NOW }
    );

    expect(quote).toMatchObject({
      schemaVersion: 1,
      currency: "USD",
      reservationMicroUsd: 2_510,
      units: 1,
      unitKind: "email_send",
      quotedAt: "2026-07-16T20:00:00.000Z",
      validUntil: "2026-07-16T20:05:00.000Z",
      safetyMarginMicroUsd: 10,
    });
    expect(quote.components).toEqual([{
      name: "email_provider_send",
      quantity: 1,
      unitKind: "email_send",
      unitMicroUsd: 2_500,
      upperBoundMicroUsd: 2_500,
      source: "operator_config",
    }]);
    expect(Object.isFrozen(quote)).toBe(true);
    expect(Object.isFrozen(quote.components)).toBe(true);
    expect(Object.isFrozen(quote.components[0])).toBe(true);
    expect(otherRecipient.pricingSnapshotSha256).toBe(quote.pricingSnapshotSha256);
    expect(otherRecipient.formulaSha256).toBe(quote.formulaSha256);
    expect(otherRecipient.limitsSha256).not.toBe(quote.limitsSha256);
  });

  it("quotes exact SMS segments and commits to the destination", () => {
    const quote = createSmsCostQuote(
      { destinationE164: "+14155550100", segmentCount: 3 },
      { environment: environment(), now: NOW }
    );
    const otherDestination = createSmsCostQuote(
      { destinationE164: "+442071838750", segmentCount: 3 },
      { environment: environment(), now: NOW }
    );

    expect(quote.units).toBe(3);
    expect(quote.reservationMicroUsd).toBe(37_045);
    expect(quote.components[0]).toMatchObject({
      quantity: 3,
      unitMicroUsd: 12_345,
      upperBoundMicroUsd: 37_035,
    });
    expect(otherDestination.limitsSha256).not.toBe(quote.limitsSha256);
    expect(errorCode(() => createSmsCostQuote(
      { destinationE164: "4155550100", segmentCount: 3 },
      { environment: environment(), now: NOW }
    ))).toBe("invalid_input");
    expect(errorCode(() => createSmsCostQuote(
      { destinationE164: "+14155550100", segmentCount: 0 },
      { environment: environment(), now: NOW }
    ))).toBe("invalid_input");
  });

  it("rounds voice duration up to a minute and binds route plus server limit", () => {
    const sixty = createVoiceCostQuote(
      { originE164: "+14155550101", destinationE164: "+14155550100", maxDurationSeconds: 60 },
      { environment: environment(), now: NOW }
    );
    const sixtyOne = createVoiceCostQuote(
      { originE164: "+14155550101", destinationE164: "+14155550100", maxDurationSeconds: 61 },
      { environment: environment(), now: NOW }
    );
    const otherOrigin = createVoiceCostQuote(
      { originE164: "+442071838751", destinationE164: "+14155550100", maxDurationSeconds: 61 },
      { environment: environment(), now: NOW }
    );

    expect(sixty.units).toBe(1);
    expect(sixty.reservationMicroUsd).toBe(125_010);
    expect(sixtyOne.units).toBe(2);
    expect(sixtyOne.reservationMicroUsd).toBe(250_010);
    expect(otherOrigin.limitsSha256).not.toBe(sixtyOne.limitsSha256);
    expect(otherOrigin.pricingSnapshotSha256).toBe(sixtyOne.pricingSnapshotSha256);
  });

  it("resolves per-call duration only within the configured provider-enforced cap", () => {
    expect(resolveVoiceMaxDurationSeconds(undefined, environment())).toBe(900);
    expect(resolveVoiceMaxDurationSeconds(61, environment())).toBe(61);
    expect(errorCode(() => resolveVoiceMaxDurationSeconds(901, environment()))).toBe("invalid_input");
    expect(errorCode(() => resolveVoiceMaxDurationSeconds(0, environment()))).toBe("invalid_input");
    expect(errorCode(() => resolveVoiceMaxDurationSeconds(undefined, environment({
      [OPERATOR_PRICING_ENV.callMaxDurationSeconds]: "86401",
    })))).toBe("invalid_configuration");
  });

  it("quotes campaign minutes once per exact target without disclosing destinations", () => {
    const quote = createVoiceCampaignCostQuote({
      originE164: "+14155550101",
      destinationE164s: ["+14155550103", "+14155550102"],
      targetSetSha256: "a".repeat(64),
      maxDurationSeconds: 61,
    }, { environment: environment(), now: NOW });
    const reordered = createVoiceCampaignCostQuote({
      originE164: "+14155550101",
      destinationE164s: ["+14155550102", "+14155550103"],
      targetSetSha256: "a".repeat(64),
      maxDurationSeconds: 61,
    }, { environment: environment(), now: NOW });

    expect(quote).toMatchObject({
      unitKind: "voice_minute",
      units: 4,
      reservationMicroUsd: 500_010,
    });
    expect(reordered.limitsSha256).toBe(quote.limitsSha256);
    expect(JSON.stringify(quote)).not.toContain("+14155550102");
    expect(JSON.stringify(quote)).not.toContain("+14155550103");
    expect(errorCode(() => createVoiceCampaignCostQuote({
      originE164: "+14155550101",
      destinationE164s: ["+14155550102", "+14155550102"],
      targetSetSha256: "a".repeat(64),
      maxDurationSeconds: 61,
    }, { environment: environment(), now: NOW }))).toBe("invalid_input");
  });

  it("quotes an exact number candidate and monthly type", () => {
    const quote = createNumberMonthlyCostQuote(
      { candidateE164: "+14155550123", countryCode: "US", numberType: "local" },
      { environment: environment(), now: NOW }
    );

    expect(quote).toMatchObject({
      reservationMicroUsd: 2_500_010,
      units: 1,
      unitKind: "phone_number_month",
    });
    expect(quote.components[0].upperBoundMicroUsd).toBe(2_500_000);
  });

  it("enforces the configured cap when constructing a quote", () => {
    expect(errorCode(() => createVoiceCostQuote(
      { originE164: "+14155550101", destinationE164: "+14155550100", maxDurationSeconds: 61 },
      {
        environment: environment({ [OPERATOR_PRICING_ENV.maxReservationUsd]: "0.25" }),
        now: NOW,
      }
    ))).toBe("quote_exceeds_cap");
  });

  it("strictly parses quote arithmetic and rejects unknown or tampered fields", () => {
    const quote = createSmsCostQuote(
      { destinationE164: "+14155550100", segmentCount: 3 },
      { environment: environment(), now: NOW }
    );
    const roundTrip = JSON.parse(JSON.stringify(quote)) as Record<string, unknown>;
    expect(parseOperatorCostQuote(roundTrip)).toEqual(quote);
    expect(Object.isFrozen(parseOperatorCostQuote(roundTrip))).toBe(true);

    expect(errorCode(() => parseOperatorCostQuote({ ...roundTrip, surprise: true }))).toBe("invalid_quote");
    expect(errorCode(() => parseOperatorCostQuote({
      ...roundTrip,
      reservationMicroUsd: quote.reservationMicroUsd + 1,
    }))).toBe("invalid_quote");
    expect(errorCode(() => parseOperatorCostQuote({
      ...roundTrip,
      components: [{ ...quote.components[0], upperBoundMicroUsd: 1 }],
    }))).toBe("invalid_quote");
    expect(errorCode(() => parseOperatorCostQuote({
      ...roundTrip,
      components: [{ ...quote.components[0], name: "email_provider_send" }],
    }))).toBe("invalid_quote");
    expect(errorCode(() => parseOperatorCostQuote({
      ...roundTrip,
      units: quote.units * 2,
      reservationMicroUsd: quote.reservationMicroUsd * 2 - quote.safetyMarginMicroUsd,
      components: [quote.components[0], quote.components[0]],
    }))).toBe("invalid_quote");
  });

  it("validates freshness, cap, unit kind, and reconstructed digests", () => {
    const quote = createVoiceCostQuote(
      { originE164: "+14155550101", destinationE164: "+14155550100", maxDurationSeconds: 61 },
      { environment: environment(), now: NOW }
    );
    const valid = assertOperatorCostQuoteUsable(quote, {
      reservationCapMicroUsd: quote.reservationMicroUsd,
      now: new Date("2026-07-16T20:04:59.999Z"),
      expectedUnitKind: "voice_minute",
      expectedPricingSnapshotSha256: quote.pricingSnapshotSha256,
      expectedFormulaSha256: quote.formulaSha256,
      expectedLimitsSha256: quote.limitsSha256,
    });
    expect(valid).toEqual(quote);

    expect(errorCode(() => assertOperatorCostQuoteUsable(quote, {
      reservationCapMicroUsd: quote.reservationMicroUsd,
      now: new Date("2026-07-16T19:59:59.999Z"),
    }))).toBe("quote_not_yet_valid");
    expect(errorCode(() => assertOperatorCostQuoteUsable(quote, {
      reservationCapMicroUsd: quote.reservationMicroUsd,
      now: new Date(quote.validUntil),
    }))).toBe("quote_expired");
    expect(errorCode(() => assertOperatorCostQuoteUsable(quote, {
      reservationCapMicroUsd: quote.reservationMicroUsd - 1,
      now: NOW,
    }))).toBe("quote_exceeds_cap");
    expect(errorCode(() => assertOperatorCostQuoteUsable(quote, {
      reservationCapMicroUsd: quote.reservationMicroUsd,
      now: NOW,
      expectedUnitKind: "sms_segment",
    }))).toBe("quote_binding_mismatch");
    expect(errorCode(() => assertOperatorCostQuoteUsable(quote, {
      reservationCapMicroUsd: quote.reservationMicroUsd,
      now: NOW,
      expectedLimitsSha256: "0".repeat(64),
    }))).toBe("quote_binding_mismatch");
  });

  it("rechecks delayed voice jobs against current price and duration ceilings without expiring approval", () => {
    const quote = createVoiceCostQuote(
      { originE164: "+14155550101", destinationE164: "+14155550100", maxDurationSeconds: 61 },
      { environment: environment(), now: NOW }
    );
    expect(assertVoiceQuoteCoversCurrentPricing(quote, {
      expectedUnits: 2,
      maxDurationSeconds: 61,
      environment: environment(),
    })).toEqual(quote);

    expect(errorCode(() => assertVoiceQuoteCoversCurrentPricing(quote, {
      expectedUnits: 1,
      maxDurationSeconds: 61,
      environment: environment(),
    }))).toBe("quote_binding_mismatch");
    expect(errorCode(() => assertVoiceQuoteCoversCurrentPricing(quote, {
      expectedUnits: 2,
      maxDurationSeconds: 61,
      environment: environment({ [OPERATOR_PRICING_ENV.voiceMinuteCeilingUsd]: "0.126" }),
    }))).toBe("quote_exceeds_cap");
    expect(errorCode(() => assertVoiceQuoteCoversCurrentPricing(quote, {
      expectedUnits: 2,
      maxDurationSeconds: 61,
      environment: environment({ [OPERATOR_PRICING_ENV.safetyMarginUsd]: "0.000011" }),
    }))).toBe("quote_exceeds_cap");
    expect(errorCode(() => assertVoiceQuoteCoversCurrentPricing(quote, {
      expectedUnits: 2,
      maxDurationSeconds: 61,
      environment: environment({ [OPERATOR_PRICING_ENV.callMaxDurationSeconds]: "60" }),
    }))).toBe("invalid_input");
  });
});
