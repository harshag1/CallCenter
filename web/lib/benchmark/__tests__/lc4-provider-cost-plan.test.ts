import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertLc4CostUnderSchedulingCeiling,
  calculateLc4CostEnvelopes,
  verifyLc4ProviderCostPlan,
  type Lc4ProviderCostPlan,
} from "../lc4-provider-cost-plan";

async function artifact(): Promise<Lc4ProviderCostPlan> {
  return JSON.parse(await readFile(resolve(
    process.cwd(),
    "../benchmarks/voice-long-horizon/HACC_LC4_PROVIDER_COST_PLAN.json",
  ), "utf8")) as Lc4ProviderCostPlan;
}

describe("LC4 provider cost plan", () => {
  it("reproduces all envelopes from current public rates and aggregate development usage", async () => {
    const input = await artifact();
    const verified = verifyLc4ProviderCostPlan(input, { asOfDate: "2026-07-21" });

    expect(verified.status).toBe("verified_under_scheduling_ceiling");
    expect(verified.pricing_age_days).toBe(0);
    expect(verified.envelopes).toEqual(input.envelopes);
    expect(verified.envelopes.nominal.total_micro_usd).toBe(457_629_424);
    expect(verified.envelopes.stress.total_micro_usd).toBe(686_444_136);
    expect(verified.envelopes.stress.total_micro_usd).toBeLessThanOrEqual(900_000_000);
    expect(verified.artifact_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed when the pricing snapshot is stale", async () => {
    await expect(async () => verifyLc4ProviderCostPlan(
      await artifact(),
      { asOfDate: "2026-07-29" },
    )).rejects.toThrow("pricing snapshot is stale");
  });

  it("rejects incomplete prices and unregistered treatment-outcome fields", async () => {
    const missingRate = structuredClone(await artifact()) as unknown as Record<string, unknown>;
    const pricing = missingRate.pricing as Array<Record<string, unknown>>;
    delete (pricing[0]!.rates as Record<string, unknown>).output_audio_micro_usd_per_million_tokens;
    expect(() => verifyLc4ProviderCostPlan(missingRate, { asOfDate: "2026-07-21" })).toThrow();

    const leakedOutcome = structuredClone(await artifact()) as unknown as Record<string, unknown>;
    (leakedOutcome.aggregate_usage as Array<Record<string, unknown>>)[0]!.condition = "host-managed-harness";
    expect(() => verifyLc4ProviderCostPlan(leakedOutcome, { asOfDate: "2026-07-21" })).toThrow();
  });

  it("rejects a price substituted under a valid first-party URL", async () => {
    const substitutedPrice = structuredClone(await artifact()) as unknown as Record<string, unknown>;
    const pricing = substitutedPrice.pricing as Array<Record<string, unknown>>;
    (pricing[0]!.rates as Record<string, unknown>).output_audio_micro_usd_per_million_tokens = 1;
    expect(() => verifyLc4ProviderCostPlan(substitutedPrice, { asOfDate: "2026-07-21" })).toThrow();
  });

  it("fails closed when recomputed stress cost exceeds the $900 ceiling", async () => {
    const overBudget = structuredClone(await artifact()) as unknown as {
      aggregate_usage: Array<Record<string, number | string>>;
      retained_development_source: Record<string, string>;
      envelopes: unknown;
    };
    overBudget.aggregate_usage[0]!.output_audio_tokens = 10 * Number(
      overBudget.aggregate_usage[0]!.output_audio_tokens,
    );
    const costPlan = overBudget as unknown as Lc4ProviderCostPlan;
    overBudget.envelopes = calculateLc4CostEnvelopes(costPlan);

    expect(() => assertLc4CostUnderSchedulingCeiling(overBudget.envelopes as ReturnType<typeof calculateLc4CostEnvelopes>))
      .toThrow("stress envelope exceeds the $900 scheduling ceiling");
  });

  it("rejects a substituted model ID", async () => {
    const substituted = structuredClone(await artifact()) as unknown as Record<string, unknown>;
    (substituted.pricing as Array<Record<string, unknown>>)[0]!.model = "gpt-realtime-latest";
    expect(() => verifyLc4ProviderCostPlan(substituted, { asOfDate: "2026-07-21" })).toThrow();
  });
});
