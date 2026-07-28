import { describe, expect, it } from "vitest";

import {
  LC4_DEV_NATIVE_RESPONSE_CONTROL_MAX_BYTES,
  assertLc4DevResponseControlFits,
  lc4DevResponseControlMaximumBytes,
} from "../lc4-development-response-control-preflight";

describe("LC4-DEV response-control fail-before-paid sizing", () => {
  it("fails with exact provider, arm, opportunity, actual, maximum, and strategy", () => {
    expect(() =>
      assertLc4DevResponseControlFits({
        provider: "gemini",
        arm: "hacc",
        opportunity_id: "lc4-dev-op-02",
        strategy: "no_gateway_dispatch",
        rendered_control: "x".repeat(4_139),
      }),
    ).toThrow(
      "LC4-DEV response control exceeds provider client limit: "
        + "provider=gemini arm=hacc opportunity=lc4-dev-op-02 "
        + "actual_bytes=4139 max_bytes=4096 strategy=no_gateway_dispatch",
    );
  });

  it("counts UTF-8 bytes rather than JavaScript code units", () => {
    expect(() =>
      assertLc4DevResponseControlFits({
        provider: "gemini",
        arm: "hacc",
        opportunity_id: "lc4-dev-op-01",
        strategy: "drain_all_registered_gateway_dispatches",
        rendered_control: "🗣".repeat(1_025),
      }),
    ).toThrow("actual_bytes=4100 max_bytes=4096");
  });

  it("keeps Native's explicit benchmark-only allowance separate from Gemini's HACC default", () => {
    expect(lc4DevResponseControlMaximumBytes("gemini", "hacc")).toBe(4_096);
    expect(lc4DevResponseControlMaximumBytes("gemini", "native")).toBe(
      LC4_DEV_NATIVE_RESPONSE_CONTROL_MAX_BYTES,
    );
    expect(
      assertLc4DevResponseControlFits({
        provider: "gemini",
        arm: "native",
        opportunity_id: "lc4-dev-op-60",
        strategy: "no_gateway_dispatch",
        rendered_control: "x".repeat(35_522),
      }),
    ).toBe(35_522);
  });

  it("accepts the exact HACC boundary and rejects one byte above it", () => {
    const common = {
      provider: "gemini" as const,
      arm: "hacc" as const,
      opportunity_id: "lc4-dev-op-60",
      strategy: "no_gateway_dispatch" as const,
    };
    expect(
      assertLc4DevResponseControlFits({
        ...common,
        rendered_control: "x".repeat(4_096),
      }),
    ).toBe(4_096);
    expect(() =>
      assertLc4DevResponseControlFits({
        ...common,
        rendered_control: "x".repeat(4_097),
      }),
    ).toThrow("actual_bytes=4097 max_bytes=4096");
  });
});
