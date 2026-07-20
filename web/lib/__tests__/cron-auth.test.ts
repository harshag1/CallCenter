import { describe, expect, it } from "vitest";
import { CRON_SECRET_MINIMUM_BYTES, authorizeCronRequest } from "../cron-auth";

const SECRET = "cron_7pQ9sV2xN4mK8rT6wY3aB5cD1eF0gHjL";

describe("cron bearer authentication", () => {
  it.each([
    [undefined, null],
    [undefined, "Bearer undefined"],
    ["", "Bearer "],
    ["undefined", "Bearer undefined"],
    ["null", "Bearer null"],
    ["short-secret", "Bearer short-secret"],
  ])("fails closed for missing, synthetic, or weak configuration", (secret, header) => {
    expect(authorizeCronRequest(header, secret)).toBe(false);
  });

  it("accepts only the exact configured opaque bearer", () => {
    expect(SECRET.length).toBeGreaterThanOrEqual(CRON_SECRET_MINIMUM_BYTES);
    expect(authorizeCronRequest(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(authorizeCronRequest(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(authorizeCronRequest(`bearer ${SECRET}`, SECRET)).toBe(false);
    expect(authorizeCronRequest(`Bearer  ${SECRET}`, SECRET)).toBe(false);
    expect(authorizeCronRequest(`Bearer ${SECRET},Bearer ${SECRET}`, SECRET)).toBe(false);
    expect(authorizeCronRequest(`Bearer ${SECRET} `, SECRET)).toBe(false);
  });

  it("rejects whitespace-bearing and oversized secrets even when the header matches", () => {
    const spaced = `${SECRET} `;
    expect(authorizeCronRequest(`Bearer ${spaced}`, spaced)).toBe(false);
    const oversized = "a".repeat(4_097);
    expect(authorizeCronRequest(`Bearer ${oversized}`, oversized)).toBe(false);
  });
});
