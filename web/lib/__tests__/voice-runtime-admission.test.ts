import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  definitions: vi.fn(),
  hasReadyDocuments: vi.fn(),
  q: vi.fn(),
  qOne: vi.fn(),
}));

vi.mock("../db", () => ({ q: mocks.q, qOne: mocks.qOne }));
vi.mock("../knowledge", () => ({ hasReadyDocuments: mocks.hasReadyDocuments }));
vi.mock("../voice-tools", () => ({
  voiceToolExtensions: { definitions: mocks.definitions },
}));

import { buildVoiceRuntimeSnapshotsForAdmissions } from "../voice";
import {
  voiceToolAdmissionScopeDigest,
  voiceToolDefinitionDigest,
} from "../voice-tools/schema";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const AGENT_ID = "00000000-0000-4000-8000-000000000002";
const CALL_ONE = "00000000-0000-4000-8000-000000000003";
const CALL_TWO = "00000000-0000-4000-8000-000000000004";

const EXTENSION = Object.freeze({
  name: "campaign_extension",
  description: "Read one call-bound campaign value.",
  implementationDigest: "d".repeat(64),
  inputSchema: { type: "object", additionalProperties: false },
  effect: "read" as const,
});

describe("batched future-call runtime admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasReadyDocuments.mockResolvedValue(false);
    mocks.q.mockResolvedValue([]);
    mocks.qOne.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM agents a JOIN agent_versions")) {
        return {
          agent_id: AGENT_ID,
          org_id: ORG_ID,
          name: "Campaign agent",
          version: 7,
          instructions: "Follow the approved campaign flow.",
          voice: "alloy",
          flow: {
            schema_version: 2,
            tool_exposure: "gateway",
            always_tools: [EXTENSION.name],
            nodes: [
              { id: "entry", label: "Incoming", kind: "incoming_call" },
              {
                id: "campaign",
                label: "Campaign",
                kind: "topic",
                steps: [{ id: "talk", label: "Talk", instructions: "Talk." }],
              },
            ],
            edges: [{ from: "entry", to: "campaign" }],
          },
          tool_ids: [],
          mcp_server_ids: [],
          settings: {},
          created_at: "2026-07-16T00:00:00.000Z",
        };
      }
      if (sql.includes("FROM orgs WHERE id")) {
        return { internet_enabled: false, allowed_domains: [] };
      }
      if (sql.includes("FROM media_renditions")) return null;
      throw new Error(`unexpected qOne: ${sql}`);
    });
    mocks.definitions.mockImplementation(async (scope: {
      callId: string;
      agentId: string;
      orgId: string;
    }) => {
      const definitionDigest = voiceToolDefinitionDigest(EXTENSION);
      return [{
        ...EXTENSION,
        admissionScopeDigest: voiceToolAdmissionScopeDigest(scope, [{
          name: EXTENSION.name,
          definitionDigest,
        }]),
      }];
    });
  });

  it("loads shared resources once but binds every extension catalog to its actual call id", async () => {
    const built = await buildVoiceRuntimeSnapshotsForAdmissions({
      agentId: AGENT_ID,
      orgId: ORG_ID,
      flowId: null,
      admissionScopeIds: [CALL_ONE, CALL_TWO],
    });

    expect(built.runtimes.map((runtime) => runtime.admissionScopeId)).toEqual([
      CALL_ONE,
      CALL_TWO,
    ]);
    expect(mocks.qOne.mock.calls.filter(([sql]) =>
      String(sql).includes("FROM agents a JOIN agent_versions")
    )).toHaveLength(1);
    expect(mocks.definitions).toHaveBeenNthCalledWith(1, {
      callId: CALL_ONE,
      agentId: AGENT_ID,
      orgId: ORG_ID,
    });
    expect(mocks.definitions).toHaveBeenNthCalledWith(2, {
      callId: CALL_TWO,
      agentId: AGENT_ID,
      orgId: ORG_ID,
    });
    expect(new Set(built.runtimes.map((runtime) => runtime.digest)).size).toBe(2);
    expect(new Set(built.runtimes.map((runtime) =>
      runtime.snapshot.extensionManifest[0]?.admissionScopeDigest
    )).size).toBe(2);
    expect(Object.isFrozen(built.runtimes)).toBe(true);
    expect(built.runtimes.every((runtime) => Object.isFrozen(runtime.snapshot))).toBe(true);
  });

  it("rejects duplicate/transplant-prone future call identities before loading the agent", async () => {
    await expect(buildVoiceRuntimeSnapshotsForAdmissions({
      agentId: AGENT_ID,
      orgId: ORG_ID,
      flowId: null,
      admissionScopeIds: [CALL_ONE, CALL_ONE],
    })).rejects.toThrow(/unique UUIDs/);
    expect(mocks.qOne).not.toHaveBeenCalled();
    expect(mocks.definitions).not.toHaveBeenCalled();
  });
});
