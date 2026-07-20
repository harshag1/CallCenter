import { describe, expect, it } from "vitest";
import {
  callRuntimeDigest,
  inspectLegacyCallRuntimeSnapshot,
  parseCallRuntimeSnapshot,
  type CallRuntimeSnapshot,
} from "../call-runtime-snapshot";

const snapshot: CallRuntimeSnapshot = {
  v: 2,
  agentVersion: 3,
  namedFlowId: null,
  flow: {
    schema_version: 2,
    nodes: [
      { id: "entry", label: "Incoming call", kind: "incoming_call" },
      { id: "help", label: "Help", kind: "topic", steps: [{ id: "answer", label: "Answer", instructions: "Help." }] },
    ],
    edges: [{ from: "entry", to: "help" }],
  },
  instructions: "Be helpful.",
  codeRevision: "commit-1",
  toolManifest: [],
  extensionManifest: [],
  externalMcpManifest: [],
  environment: {
    internetEnabled: false,
    allowedDomains: [],
    docsReady: false,
    datasetSlugs: [],
    holdMusic: false,
  },
  createdAt: "2026-07-10T00:00:00.000Z",
};

describe("call runtime snapshots", () => {
  it("verifies the immutable manifest digest", () => {
    const digest = callRuntimeDigest(snapshot);
    expect(parseCallRuntimeSnapshot(structuredClone(snapshot), digest)).toEqual({ snapshot, digest });
    expect(() => parseCallRuntimeSnapshot({ ...snapshot, instructions: "changed" }, digest)).toThrow(/digest mismatch/);
  });

  it("distinguishes an omitted digest from every invalid supplied digest", () => {
    expect(parseCallRuntimeSnapshot(structuredClone(snapshot))).toEqual({
      snapshot,
      digest: callRuntimeDigest(snapshot),
    });
    for (const supplied of [undefined, null, "", "not-a-digest", "A".repeat(64)]) {
      expect(() => parseCallRuntimeSnapshot(structuredClone(snapshot), supplied))
        .toThrow(/lowercase SHA-256 digest/);
    }
  });

  it("rejects semantically invalid pinned flows and ambiguous executable catalogs", () => {
    const invalidFlow = structuredClone(snapshot);
    invalidFlow.flow.nodes[1].steps!.push({
      id: "answer",
      label: "Duplicate",
      instructions: "This path collides.",
    });
    expect(() => parseCallRuntimeSnapshot(invalidFlow)).toThrow(/duplicate step path/);

    const collision = structuredClone(snapshot);
    collision.toolManifest.push({
      id: "tool-1",
      slug: "colliding_tool",
      description: "Pinned generated tool.",
      inputSchema: { type: "object" },
      endpointUrl: "https://example.com/tool",
      invocationKeyId: "key-1",
    });
    collision.extensionManifest.push({
      name: "colliding_tool",
      description: "Extension with the same executable name.",
      implementationDigest: "a".repeat(64),
      admissionScopeDigest: "b".repeat(64),
      inputSchema: { type: "object" },
    });
    expect(() => parseCallRuntimeSnapshot(collision)).toThrow(/collides/);
  });

  it("rejects legacy extension authority instead of synthesizing current admission state", () => {
    const legacy = structuredClone(snapshot) as unknown as {
      v: number;
      extensionManifest: Record<string, unknown>[];
    };
    legacy.v = 1;
    legacy.extensionManifest.push({
      name: "legacy_extension",
      description: "Predates call-bound admission.",
      implementationDigest: "a".repeat(64),
      inputSchema: { type: "object" },
    });
    expect(() => parseCallRuntimeSnapshot(legacy)).toThrow(/start a fresh call/);
    expect(inspectLegacyCallRuntimeSnapshot(legacy)).toMatchObject({
      executable: false,
      snapshot: { v: 1 },
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("rejects extension descriptors from different admitted catalogs", () => {
    const mixed = structuredClone(snapshot);
    mixed.extensionManifest.push({
      name: "catalog_one",
      description: "First extension.",
      implementationDigest: "1".repeat(64),
      admissionScopeDigest: "a".repeat(64),
      inputSchema: { type: "object" },
    }, {
      name: "catalog_two",
      description: "Second extension.",
      implementationDigest: "2".repeat(64),
      admissionScopeDigest: "b".repeat(64),
      inputSchema: { type: "object" },
    });
    expect(() => parseCallRuntimeSnapshot(mixed)).toThrow(/mixes different/);
  });

  it("keeps v1 inspection separate from v2 execution and rejects cross-version digests", () => {
    const legacy = { ...structuredClone(snapshot), v: 1 };
    const inspected = inspectLegacyCallRuntimeSnapshot(legacy);
    expect(inspected.executable).toBe(false);
    expect(inspected.snapshot.v).toBe(1);
    expect(inspected.digest).not.toBe(callRuntimeDigest(snapshot));
    expect(() => parseCallRuntimeSnapshot(legacy)).toThrow(/read-only/);
    expect(() => inspectLegacyCallRuntimeSnapshot(snapshot)).toThrow(/expected a legacy/);
    expect(() => parseCallRuntimeSnapshot(snapshot, inspected.digest)).toThrow(/digest mismatch/);
  });
});
