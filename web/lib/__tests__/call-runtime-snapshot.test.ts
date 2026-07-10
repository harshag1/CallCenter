import { describe, expect, it } from "vitest";
import { callRuntimeDigest, parseCallRuntimeSnapshot, type CallRuntimeSnapshot } from "../call-runtime-snapshot";

const snapshot: CallRuntimeSnapshot = {
  v: 1,
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
});
