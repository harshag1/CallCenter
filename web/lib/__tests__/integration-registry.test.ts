import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  INTEGRATIONS,
  createIntegrationRegistry,
  defineIntegration,
  integrationStatuses,
} from "../integrations";

const example = {
  id: "warehouse",
  label: "Warehouse",
  category: "data" as const,
  description: "Fetch inventory from the caller's warehouse.",
  docsUrl: "https://example.com/docs",
  requiredEnv: ["WAREHOUSE_TOKEN"],
  alternativeEnv: [["WAREHOUSE_REGION"], ["WAREHOUSE_URL", "WAREHOUSE_URL_TOKEN"]],
  optionalEnv: ["WAREHOUSE_TIMEOUT_MS"],
  capabilities: ["inventory-read"],
};

describe("integration registry", () => {
  it("exposes every built-in integration through an immutable validated catalog", () => {
    expect(INTEGRATIONS.map((integration) => integration.id)).toEqual([
      "xai",
      "openai",
      "gemini",
      "twilio",
      "resend",
      "supabase",
      "vercel-tools",
    ]);
    expect(Object.isFrozen(INTEGRATIONS)).toBe(true);
    expect(INTEGRATIONS.every((integration) =>
      Object.isFrozen(integration) &&
      Object.isFrozen(integration.requiredEnv) &&
      Object.isFrozen(integration.capabilities)
    )).toBe(true);
  });

  it("lets an extension compose and inspect configuration without reading ambient secrets", () => {
    const registry = createIntegrationRegistry([example]);
    const incomplete = registry.statuses({
      WAREHOUSE_TOKEN: "secret",
      WAREHOUSE_URL: "https://warehouse.example",
    });
    expect(incomplete).toEqual([expect.objectContaining({
      id: "warehouse",
      configured: false,
      missingEnv: [],
      missingAlternatives: [["WAREHOUSE_REGION"], ["WAREHOUSE_URL_TOKEN"]],
    })]);
    expect(JSON.stringify(incomplete)).not.toContain("secret");
    expect(JSON.stringify(incomplete)).not.toContain("https://warehouse.example");

    const ready = registry.statuses({
      WAREHOUSE_TOKEN: "secret",
      WAREHOUSE_REGION: "us-west",
    });
    expect(ready[0]).toEqual(expect.objectContaining({
      configured: true,
      missingEnv: [],
      missingAlternatives: [],
    }));
    expect(Object.isFrozen(ready)).toBe(true);
    expect(Object.isFrozen(ready[0])).toBe(true);
  });

  it("preserves the zero-argument status API while accepting deterministic env injection", () => {
    const statuses = integrationStatuses({});
    expect(statuses).toHaveLength(INTEGRATIONS.length);
    expect(statuses.find((integration) => integration.id === "resend")).toEqual(
      expect.objectContaining({
        configured: false,
        missingEnv: ["EMAIL_FROM", "RESEND_API_KEY"],
      })
    );
  });

  it("rejects ambiguous, mutable, or non-portable manifests before registration", () => {
    expect(() => createIntegrationRegistry([example, example])).toThrow(/duplicate integration/);
    expect(() => defineIntegration({ ...example, docsUrl: "http://example.com" })).toThrow(/public HTTPS/);
    expect(() => defineIntegration({
      ...example,
      requiredEnv: ["warehouse-token"],
    })).toThrow(/invalid value/);
    expect(() => defineIntegration({
      ...example,
      optionalEnv: ["WAREHOUSE_TOKEN"],
    })).toThrow(/repeats a required and optional/);
    expect(() => defineIntegration({
      ...example,
      alternativeEnv: [[]],
    })).toThrow(/alternative 1 is empty/);
  });
});
