import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

describe("global browser security headers", () => {
  it("denies framing for every page and API route", async () => {
    expect(nextConfig.headers).toBeTypeOf("function");
    const rules = await nextConfig.headers!();
    const global = rules.find((rule) => rule.source === "/:path*");
    expect(global).toBeDefined();
    const headers = new Map(global!.headers.map((header) => [
      header.key.toLowerCase(),
      header.value,
    ]));
    expect(headers.get("content-security-policy")).toMatch(/(?:^|;)\s*frame-ancestors 'none'(?:;|$)/);
    expect(headers.get("x-frame-options")).toBe("DENY");
  });
});
