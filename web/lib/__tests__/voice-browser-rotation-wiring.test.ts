import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  q: vi.fn(),
  qOne: vi.fn(),
  activeConversationRouteAuthorityFor: vi.fn(),
  preparePostgresLiveConversationRoute: vi.fn(),
}));

vi.mock("../db", () => ({ q: mocks.q, qOne: mocks.qOne }));
vi.mock("../mcp", () => ({
  activeConversationRouteAuthorityFor: mocks.activeConversationRouteAuthorityFor,
}));
vi.mock("../live-conversation-route-postgres", () => ({
  preparePostgresLiveConversationRoute: mocks.preparePostgresLiveConversationRoute,
}));

import {
  callRuntimeDigest,
  type CallRuntimeSnapshot,
} from "../call-runtime-snapshot";
import { authorizeLocalDeploymentBrowserFunding } from "../realtime/browser-funding-authority";
import { verifyScope, voiceSessionSpecForCall, type AgentVersionRow } from "../voice";

const BASE_MS = Date.parse("2026-07-16T20:00:00.000Z");
const ORIGIN = "https://voice.example.test";
const CALL_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";
const CATALOG_DIGEST = "c".repeat(64);
const TENANT_OPENAI_ROOT = "tenant-openai-root-never-enters-session-spec";
const LOCAL_OPENAI_ROOT = "local-openai-root-never-enters-session-spec";

const snapshot: CallRuntimeSnapshot = {
  v: 2,
  agentVersion: 3,
  namedFlowId: null,
  flow: {
    schema_version: 2,
    nodes: [
      { id: "entry", label: "Incoming call", kind: "incoming_call" },
      {
        id: "help",
        label: "Help",
        kind: "topic",
        steps: [{ id: "answer", label: "Answer", instructions: "Help the caller." }],
      },
    ],
    edges: [{ from: "entry", to: "help" }],
  },
  instructions: "Follow the durable help flow.",
  codeRevision: "rotation-wiring-test",
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
  createdAt: "2026-07-16T00:00:00.000Z",
};

const agent: AgentVersionRow = {
  agent_id: AGENT_ID,
  org_id: ORG_ID,
  name: "Rotation agent",
  version: 3,
  instructions: snapshot.instructions,
  voice: "marin",
  flow: snapshot.flow,
  tool_ids: [],
  mcp_server_ids: [],
  settings: { voice_provider: "openai", voice_model: "gpt-realtime-2.1" },
  created_at: snapshot.createdAt,
};

describe("browser voice-session capability rotation wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(BASE_MS);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_ORIGIN", ORIGIN);
    vi.stubEnv("MCP_GATEWAY_SECRET", "browser-wiring-test-secret-is-at-least-32-bytes");
    mocks.q.mockResolvedValue([]);
    mocks.qOne.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM calls WHERE id")) {
        return {
          direction: "web",
          from_number: null,
          to_number: null,
          experiment_id: null,
          variant: null,
          agent_version: 3,
          flow_id: null,
          runtime_snapshot: structuredClone(snapshot),
          runtime_digest: callRuntimeDigest(snapshot),
          started_at: new Date(BASE_MS),
        };
      }
      throw new Error(`unexpected qOne query: ${sql}`);
    });
    const catalog = {
        schema_version: 1,
        availability: "active",
        runtime_digest: callRuntimeDigest(snapshot),
        capability_epoch: 7,
        state_revision: 11,
        scope: { status: "active", topic: "help", step: "answer", attempt: 0 },
        active_context: {
          disclosure_metrics: {
            tool_count: 0,
            catalog_bytes: 0,
            estimated_tokens_at_4_bytes_per_token: 0,
          },
        },
        catalog_digest: CATALOG_DIGEST,
        tools: [],
      };
    mocks.activeConversationRouteAuthorityFor.mockResolvedValue({
      authority: { catalog, privateBindings: {} },
      flow: null,
    });
    mocks.preparePostgresLiveConversationRoute.mockResolvedValue({
      packet: {
        serialized: JSON.stringify({ schemaVersion: 1, authority: {} }),
        byteLength: 42,
        value: { schemaVersion: 1, authority: {} },
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("issues distinct generation-zero MCP/renewal capabilities and the exact local renewal contract", async () => {
    const spec = await voiceSessionSpecForCall(
      agent,
      CALL_ID,
      "web",
      ORIGIN,
      {
        source: "tenant_byok",
        provider: "openai",
        apiKey: TENANT_OPENAI_ROOT,
      },
    );
    expect(spec).toMatchObject({
      provider: "openai",
      model: "gpt-realtime-2.1",
      toolProxyUrl: `${ORIGIN}/api/mcp`,
      activeCatalogAuthority: {
        catalogDigest: CATALOG_DIGEST,
        capabilityEpoch: 7,
        runtimeDigest: callRuntimeDigest(snapshot),
        stateRevision: 11,
      },
      toolProxyRotation: {
        endpoint: "/api/voice/capabilities/rotate",
        callId: CALL_ID,
        rotation: 0,
        refreshAfter: "2026-07-16T20:25:00.000Z",
        expiresAt: "2026-07-16T20:30:00.000Z",
      },
    });
    const rotation = spec.toolProxyRotation;
    expect(rotation).toBeDefined();
    if (!rotation) throw new Error("expected browser rotation authority");
    expect(rotation.renewalToken).not.toBe(spec.toolProxyToken);
    expect(spec.mcpServers).toEqual([{
      label: "callcenter",
      serverUrl: `${ORIGIN}/api/mcp`,
      authorization: `Bearer ${spec.toolProxyToken}`,
    }]);
    expect(JSON.stringify(spec)).not.toContain(TENANT_OPENAI_ROOT);
    const initialMcp = verifyScope(spec.toolProxyToken, {
      audience: "mcp",
      purpose: "tool-invocation",
      method: "POST",
      provider: "openai",
      callId: CALL_ID,
      agentId: AGENT_ID,
      orgId: ORG_ID,
    });
    const initialRenewal = verifyScope(rotation.renewalToken, {
      audience: "browser_refresh",
      purpose: "capability_rotation",
      method: "POST",
      provider: "openai",
      callId: CALL_ID,
      agentId: AGENT_ID,
      orgId: ORG_ID,
    });
    expect(initialMcp).toMatchObject({ iat: BASE_MS / 1_000, exp: BASE_MS / 1_000 + 30 * 60 });
    expect(initialRenewal).toMatchObject({ iat: BASE_MS / 1_000, exp: BASE_MS / 1_000 + 30 * 60 });
    expect(initialMcp?.jti).not.toBe(initialRenewal?.jti);
    expect(spec.instructions).toContain("<ACTIVE_CAPABILITY_CATALOG>");
    expect(spec.instructions).not.toContain(spec.toolProxyToken);
    expect(spec.instructions).not.toContain(rotation.renewalToken);
    expect(mocks.activeConversationRouteAuthorityFor).toHaveBeenCalledWith({
      callId: CALL_ID,
      agentId: AGENT_ID,
      orgId: ORG_ID,
    });
  });

  it("builds the stock OpenAI browser session on authorized plain-HTTP loopback", async () => {
    const localOrigin = "http://localhost:3000";
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("PUBLIC_ORIGIN", localOrigin);
    vi.stubEnv("ALLOW_DEV_DEPLOYMENT_FUNDED_AI", "true");
    vi.stubEnv("OPENAI_API_KEY", LOCAL_OPENAI_ROOT);
    const authority = authorizeLocalDeploymentBrowserFunding("openai");
    if (!authority) throw new Error("expected local OpenAI funding authority");

    const spec = await voiceSessionSpecForCall(
      agent,
      CALL_ID,
      "web",
      localOrigin,
      authority,
    );
    expect(spec).toMatchObject({
      provider: "openai",
      toolProxyUrl: `${localOrigin}/api/mcp`,
    });
    expect(JSON.stringify(spec)).not.toContain(LOCAL_OPENAI_ROOT);
    expect(JSON.stringify(authority)).not.toContain(LOCAL_OPENAI_ROOT);
  });

  it("does not carry a loopback deployment authority onto an HTTPS tunnel", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("PUBLIC_ORIGIN", "http://localhost:3000");
    vi.stubEnv("ALLOW_DEV_DEPLOYMENT_FUNDED_AI", "true");
    vi.stubEnv("OPENAI_API_KEY", LOCAL_OPENAI_ROOT);
    const authority = authorizeLocalDeploymentBrowserFunding("openai");
    if (!authority) throw new Error("expected local OpenAI funding authority");

    vi.stubEnv("PUBLIC_ORIGIN", ORIGIN);
    await expect(voiceSessionSpecForCall(
      agent,
      CALL_ID,
      "web",
      ORIGIN,
      authority,
    )).rejects.toThrow(/plain-HTTP loopback/);
    expect(mocks.activeConversationRouteAuthorityFor).not.toHaveBeenCalled();
  });
});
