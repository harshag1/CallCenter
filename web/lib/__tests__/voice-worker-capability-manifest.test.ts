import { describe, expect, it } from "vitest";
import { buildActiveCapabilityCatalog } from "../active-capability-catalog";
import { deriveActiveReadOnlyWorkerManifest } from "../voice-workers/capability-manifest";

const definition = (
  name: string,
  effect: "read" | "write" | "opaque",
  target?: string,
) => ({
  kind: "direct" as const,
  definition: {
    name,
    description: `${name} description`,
    inputSchema: { type: "object", properties: {} },
    effect,
  },
  ...(target ? { target } : {}),
});

function catalog(sources: Parameters<typeof buildActiveCapabilityCatalog>[0]["sources"]) {
  return buildActiveCapabilityCatalog({
    runtimeDigest: "a".repeat(64),
    state: {
      status: "active",
      topic: "membership",
      step: "membership.lookup",
      attempt: 1,
      capabilityEpoch: 7,
      stateRevision: 11,
    },
    context: {},
    sources,
  });
}

describe("active read-only worker capability manifest", () => {
  it("pins only the sorted intersection of the active step and executable background catalog", () => {
    const manifest = deriveActiveReadOnlyWorkerManifest({
      catalog: catalog([
        definition("search_knowledge", "read"),
        definition("launch_task", "write"),
        definition("read_table", "read"),
        definition("search", "read"),
      ]),
      executableBackgroundToolNames: ["search_knowledge", "read_table"],
    });

    expect(manifest).toEqual({
      v: 1,
      mode: "read_only",
      capabilities: ["read_table", "search_knowledge"],
      networkOrigins: [],
    });
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.capabilities)).toBe(true);
  });

  it("does not inherit an inactive, write, opaque, or hidden direct-alias surface", () => {
    const active = catalog([
      definition("search_knowledge", "read"),
      definition("write_table", "write"),
      definition("extension_probe", "opaque"),
      definition("safe_alias", "read", "search_knowledge"),
    ]);
    const manifest = deriveActiveReadOnlyWorkerManifest({
      catalog: active,
      executableBackgroundToolNames: [
        "search_knowledge",
        "read_table",
        "write_table",
        "extension_probe",
        "safe_alias",
      ],
    });
    expect(manifest.capabilities).toEqual(["search_knowledge"]);
  });

  it("fails closed when the active step exposes no executable read", () => {
    expect(() => deriveActiveReadOnlyWorkerManifest({
      catalog: catalog([definition("launch_task", "write")]),
      executableBackgroundToolNames: ["read_table", "search", "search_knowledge"],
    })).toThrow(/active Flow step grants no background-safe read capability/);
  });

  it("rejects blocked catalogs and duplicate executable definitions", () => {
    const active = catalog([definition("search", "read")]);
    expect(() => deriveActiveReadOnlyWorkerManifest({
      catalog: { ...active, availability: "blocked" },
      executableBackgroundToolNames: ["search"],
    })).toThrow(/blocked active capability catalog/);
    expect(() => deriveActiveReadOnlyWorkerManifest({
      catalog: active,
      executableBackgroundToolNames: ["search", "search"],
    })).toThrow(/duplicate names/);
  });
});
