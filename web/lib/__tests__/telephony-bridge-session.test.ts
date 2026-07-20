import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  qOne: vi.fn(),
  query: vi.fn(),
  connect: vi.fn(),
  release: vi.fn(),
  ensureSafeDatabaseRuntimeRole: vi.fn(),
  loadActiveAgent: vi.fn(),
  voiceSessionSpecForCall: vi.fn(),
  buildProviderSessionUpdate: vi.fn(),
  serverRealtimeEndpoint: vi.fn(),
  requireBridgeWsUrl: vi.fn(),
  requirePublicOrigin: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  qOne: mocks.qOne,
  ensureSafeDatabaseRuntimeRole: mocks.ensureSafeDatabaseRuntimeRole,
  getPool: () => ({ connect: mocks.connect }),
}));
vi.mock("@/lib/voice", async () => {
  const actual = await import("../voice");
  return {
    ...actual,
    loadActiveAgent: mocks.loadActiveAgent,
    voiceSessionSpecForCall: mocks.voiceSessionSpecForCall,
  };
});
vi.mock("@/lib/realtime/registry", () => ({
  buildProviderSessionUpdate: mocks.buildProviderSessionUpdate,
  serverRealtimeEndpoint: mocks.serverRealtimeEndpoint,
}));
vi.mock("@/lib/telephony", () => ({
  requireBridgeWsUrl: mocks.requireBridgeWsUrl,
  requirePublicOrigin: mocks.requirePublicOrigin,
}));

import * as bridgeSessionRoute from "../../app/api/telephony/bridge/session/route";
import { BootstrapClient } from "../../../bridge/lib/bootstrap-client.js";
import { validateProviderConfig } from "../../../bridge/lib/provider-adapter.js";
import { buildOpenAISession } from "../realtime/providers/openai-protocol";
import { buildXaiSessionUpdate } from "../realtime/providers/xai-protocol";
import type { RealtimeAudioFormat, VoiceSessionSpec } from "../realtime/types";
import { signScope, verifyScope } from "../voice";

const CompilerBootstrapClient = BootstrapClient as unknown as new (options: {
  appOrigin: string;
  now: () => number;
  fetchImpl: typeof fetch;
}) => InstanceType<typeof BootstrapClient>;
const { POST } = bridgeSessionRoute;

const NOW = Date.parse("2026-07-16T20:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW / 1_000);
const APP_ORIGIN = "https://voice.example.test";
const BRIDGE_URL = "wss://bridge.example.test/twilio/media";
const BRIDGE_ORIGIN_SHA256 = createHash("sha256").update(BRIDGE_URL, "utf8").digest("hex");
const SECRET = "test-capability-secret-that-is-longer-than-thirty-two-bytes";
const CALL_ID = "00000000-0000-4000-8000-000000000041";
const AGENT_ID = "00000000-0000-4000-8000-000000000042";
const ORG_ID = "00000000-0000-4000-8000-000000000043";
const CALL_SID = `CA${"5".repeat(32)}`;
const OTHER_CALL_SID = `CA${"6".repeat(32)}`;
const ACCOUNT_SID = `AC${"7".repeat(32)}`;
const OTHER_ACCOUNT_SID = `AC${"8".repeat(32)}`;
const STREAM_SID = `MZ${"9".repeat(32)}`;
const TO = "+14155550101";
const SESSION_ID = "bridge-session-1";
const BRIDGE_INSTANCE_ID = "bridge-instance-1";
const ROOT_JTI = "r".repeat(22);
const PLACEHOLDER = "__HACC_BRIDGE_MCP_CAPABILITY_V1__";
const CATALOG_DIGEST = "c".repeat(64);

const connection = {
  account_sid: ACCOUNT_SID,
  call_sid: CALL_SID,
  stream_sid: STREAM_SID,
  mode: "agent" as const,
};

function body(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 3,
    session_id: SESSION_ID,
    bridge_instance_id: BRIDGE_INSTANCE_ID,
    connection,
    ...overrides,
  };
}

function rootToken(jti = ROOT_JTI) {
  return signScope(
    { callId: CALL_ID, agentId: AGENT_ID, orgId: ORG_ID },
    {
      audience: "bridge_bootstrap",
      purpose: "telephony_stream_exchange",
      method: "POST",
      provider: "twilio",
      ttlSeconds: 300,
      issuedAt: NOW_SECONDS,
      jti,
      providerCallId: CALL_SID,
      providerAccountId: ACCOUNT_SID,
      providerTo: TO,
      bridgeOriginSha256: BRIDGE_ORIGIN_SHA256,
    }
  );
}

function request(payload: unknown, options: {
  token?: string;
  idempotencyKey?: string;
  url?: string;
  contentType?: string;
} = {}) {
  return new Request(options.url ?? `${APP_ORIGIN}/api/telephony/bridge/session`, {
    method: "POST",
    headers: {
      "Content-Type": options.contentType ?? "application/json",
      ...(options.token === "" ? {} : { Authorization: `Bearer ${options.token ?? rootToken()}` }),
      "Idempotency-Key": options.idempotencyKey ?? SESSION_ID,
    },
    body: JSON.stringify(payload),
  });
}

type StoredBinding = {
  jti: string;
  audience: string;
  call_id: string;
  stream_sid: string;
  session_id: string;
  bridge_instance_id: string;
  binding_bootstrap_jti: string;
  provider_account_sid: string;
  provider_call_sid: string;
  to_number: string;
  mode: string;
  bootstrap_session_config: string;
  rotation_root_jti: string | null;
  rotation_generation: number | null;
  rotation_issued_at: number | null;
  rotation_provider: string | null;
};

let storedBinding: StoredBinding | null;
let insertedBindingParams: unknown[] | null;

function installTransactionHarness() {
  storedBinding = null;
  insertedBindingParams = null;
  mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rowCount: null, rows: [] };
    }
    if (sql.includes("SELECT c.id") && sql.includes("FOR UPDATE OF c")) {
      return { rowCount: 1, rows: [{ id: CALL_ID }] };
    }
    if (sql.includes("SELECT consumption.jti")) {
      return storedBinding
        ? { rowCount: 1, rows: [storedBinding] }
        : { rowCount: 0, rows: [] };
    }
    if (sql.includes("INSERT INTO telephony_stream_bindings")) {
      insertedBindingParams = params;
      storedBinding = {
        jti: ROOT_JTI,
        audience: "bridge_bootstrap",
        call_id: CALL_ID,
        stream_sid: String(params[0]),
        session_id: String(params[6]),
        bridge_instance_id: String(params[7]),
        binding_bootstrap_jti: String(params[8]),
        provider_account_sid: String(params[2]),
        provider_call_sid: String(params[3]),
        to_number: String(params[4]),
        mode: String(params[5]),
        bootstrap_session_config: String(params[9]),
        rotation_root_jti: null,
        rotation_generation: null,
        rotation_issued_at: null,
        rotation_provider: null,
      };
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes("INSERT INTO telephony_capability_consumptions")) {
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes("INSERT INTO voice_capability_rotations")) {
      if (!storedBinding) throw new Error("rotation inserted before stream binding");
      storedBinding.rotation_provider = String(params[4]);
      storedBinding.rotation_root_jti = String(params[5]);
      storedBinding.rotation_generation = 0;
      storedBinding.rotation_issued_at = Number(params[6]);
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`unexpected transaction query: ${sql}`);
  });
}

describe("standalone bridge bootstrap exchange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv("MCP_GATEWAY_SECRET", SECRET);
    mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
    mocks.ensureSafeDatabaseRuntimeRole.mockResolvedValue(undefined);
    mocks.qOne.mockResolvedValue({ direction: "inbound", metadata: {} });
    mocks.loadActiveAgent.mockResolvedValue({ agent_id: AGENT_ID, org_id: ORG_ID });
    mocks.voiceSessionSpecForCall.mockResolvedValue({
      provider: "openai",
      model: "gpt-realtime",
      voice: "alloy",
      settings: {},
      instructions: "Follow the durable call flow.",
      mcpServers: [{
        label: "hacc-tools",
        serverUrl: `${APP_ORIGIN}/api/mcp`,
        authorization: "Bearer bootstrap-must-not-survive",
      }],
      toolProxyUrl: `${APP_ORIGIN}/api/mcp`,
      toolProxyToken: "bootstrap-must-not-survive",
      activeCatalogAuthority: {
        catalogDigest: CATALOG_DIGEST,
        capabilityEpoch: 7,
        runtimeDigest: "e".repeat(64),
        stateRevision: 11,
      },
    });
    mocks.serverRealtimeEndpoint.mockImplementation((spec: VoiceSessionSpec) => ({
      provider: spec.provider,
      wsUrl: `wss://${spec.provider === "xai" ? "api.x.ai" : "api.openai.com"}/v1/realtime?model=${encodeURIComponent(spec.model)}`,
    }));
    mocks.buildProviderSessionUpdate.mockImplementation((spec: VoiceSessionSpec, audio: RealtimeAudioFormat) => (
      spec.provider === "xai"
        ? buildXaiSessionUpdate(spec, audio)
        : { type: "session.update", session: buildOpenAISession(spec, audio) }
    ));
    mocks.requireBridgeWsUrl.mockReturnValue(BRIDGE_URL);
    mocks.requirePublicOrigin.mockReturnValue(APP_ORIGIN);
    installTransactionHarness();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("accepts bootstrap authority only from Bearer and binds Idempotency-Key to session_id", async () => {
    expect(bridgeSessionRoute).not.toHaveProperty("GET");
    const queryOnly = await POST(request(body(), {
      token: "",
      url: `${APP_ORIGIN}/api/telephony/bridge/session?scope=${rootToken()}`,
    }));
    expect(queryOnly.status).toBe(401);
    expect(mocks.qOne).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();

    const wrongIdempotency = await POST(request(body(), { idempotencyKey: "another-session" }));
    expect(wrongIdempotency.status).toBe(400);
    expect(await wrongIdempotency.json()).toEqual({ error: "idempotency binding mismatch" });
    expect(mocks.qOne).not.toHaveBeenCalled();
  });

  it("rejects non-exact schemas and unsupported modes before capability or database work", async () => {
    const observe = body({ connection: { ...connection, mode: "observe" } });
    expect((await POST(request(observe))).status).toBe(400);

    const extra = body({ attacker_field: "ignored-by-lenient-parsers" });
    expect((await POST(request(extra))).status).toBe(400);

    expect((await POST(request(body(), { contentType: "text/plain" }))).status).toBe(415);

    const duplicateSchema = JSON.stringify(body()).replace(
      '"schema_version":3',
      '"schema_version":3,"schema\\u005fversion":2',
    );
    const duplicateResponse = await POST(new Request(`${APP_ORIGIN}/api/telephony/bridge/session`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${rootToken()}`,
        "Content-Type": "application/json",
        "Idempotency-Key": SESSION_ID,
      },
      body: duplicateSchema,
    }));
    expect(duplicateResponse.status).toBe(400);
    expect(mocks.qOne).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("rejects account, call, and trusted bridge-origin substitutions before database access", async () => {
    expect((await POST(request(body({
      connection: { ...connection, account_sid: OTHER_ACCOUNT_SID },
    })))).status).toBe(401);
    expect((await POST(request(body({
      connection: { ...connection, call_sid: OTHER_CALL_SID },
    })))).status).toBe(401);

    mocks.requireBridgeWsUrl.mockReturnValue("wss://other-bridge.example.test/twilio/media");
    expect((await POST(request(body()))).status).toBe(401);
    expect(mocks.qOne).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("returns the exact compiler schema with separated, fully bound child capabilities", async () => {
    const bootstrap = rootToken();
    const response = await POST(request(body(), { token: bootstrap }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const payload = await response.json();
    expect(Object.keys(payload).sort()).toEqual([
      "active_catalog_authority", "bridge_instance_id", "call_id", "connection",
      "event_capability", "expires_at", "mcp_capability", "model", "provider",
      "refresh_after", "renewal_capability", "rotation", "rotation_endpoint",
      "schema_version", "session_id", "session_update", "ws_url",
    ].sort());
    expect(payload).toMatchObject({
      schema_version: 3,
      session_id: SESSION_ID,
      bridge_instance_id: BRIDGE_INSTANCE_ID,
      call_id: CALL_ID,
      connection,
      provider: "openai",
      model: "gpt-realtime",
      ws_url: "wss://api.openai.com/v1/realtime?model=gpt-realtime",
      rotation: 0,
      rotation_endpoint: "/api/telephony/bridge/capabilities/rotate",
      refresh_after: "2026-07-16T20:25:00.000Z",
      event_capability: {
        audience: "telephony_events",
        purpose: "event_journal",
        expires_at: "2026-07-16T20:30:00.000Z",
      },
      mcp_capability: {
        audience: "bridge_mcp",
        purpose: "tool_invocation",
        expires_at: "2026-07-16T20:30:00.000Z",
      },
      renewal_capability: {
        audience: "bridge_refresh",
        purpose: "capability_rotation",
        expires_at: "2026-07-16T20:30:00.000Z",
      },
      active_catalog_authority: {
        catalog_digest: CATALOG_DIGEST,
        capability_epoch: 7,
      },
      expires_at: "2026-07-16T20:30:00.000Z",
    });
    const eventToken = payload.event_capability.token as string;
    const mcpToken = payload.mcp_capability.token as string;
    const renewalToken = payload.renewal_capability.token as string;
    expect(new Set([bootstrap, eventToken, mcpToken, renewalToken]).size).toBe(4);
    expect(verifyScope(eventToken, {
      audience: "telephony_events",
      purpose: "event_journal",
      method: "POST",
      provider: "twilio",
      callId: CALL_ID,
      agentId: AGENT_ID,
      orgId: ORG_ID,
      providerCallId: CALL_SID,
      providerAccountId: ACCOUNT_SID,
      providerTo: TO,
      providerStreamId: STREAM_SID,
    })).not.toBeNull();
    expect(verifyScope(renewalToken, {
      audience: "bridge_refresh",
      purpose: "capability_rotation",
      method: "POST",
      provider: "openai",
      transportProvider: "twilio",
      callId: CALL_ID,
      agentId: AGENT_ID,
      orgId: ORG_ID,
      providerCallId: CALL_SID,
      providerAccountId: ACCOUNT_SID,
      providerTo: TO,
      providerStreamId: STREAM_SID,
    })).not.toBeNull();
    expect(verifyScope(mcpToken, {
      audience: "bridge_mcp",
      purpose: "tool_invocation",
      method: "POST",
      provider: "openai",
      transportProvider: "twilio",
      callId: CALL_ID,
      agentId: AGENT_ID,
      orgId: ORG_ID,
      providerCallId: CALL_SID,
      providerAccountId: ACCOUNT_SID,
      providerTo: TO,
      providerStreamId: STREAM_SID,
    })).not.toBeNull();
    expect(payload.session_update.session.tools).toHaveLength(1);
    expect(payload.session_update.session.tools[0]).toMatchObject({
      type: "function",
      name: "capability_gateway",
    });
    expect(() => validateProviderConfig({
      provider: payload.provider,
      wsUrl: payload.ws_url,
      model: payload.model,
      sessionUpdate: payload.session_update,
    }, { allowedClientTools: ["capability_gateway"] })).not.toThrow();
    const providerWire = JSON.stringify(payload.session_update);
    expect(providerWire).not.toContain(mcpToken);
    expect(providerWire).not.toContain(eventToken);
    expect(providerWire).not.toContain(renewalToken);
    expect(providerWire).not.toContain(bootstrap);
    expect(providerWire).not.toContain('"type":"mcp"');
    expect(providerWire).not.toContain("authorization");
    expect(providerWire).not.toContain("/api/mcp");
    expect(JSON.stringify(payload)).not.toContain(bootstrap);
    expect(JSON.stringify(payload.session_update)).not.toContain(eventToken);
    expect(JSON.stringify(payload.session_update)).not.toContain(renewalToken);

    expect(mocks.qOne.mock.calls[0][1]).toEqual([
      CALL_ID, AGENT_ID, ORG_ID, CALL_SID, ACCOUNT_SID, TO,
    ]);
    expect(insertedBindingParams).toEqual([
      STREAM_SID,
      CALL_ID,
      ACCOUNT_SID,
      CALL_SID,
      TO,
      "agent",
      SESSION_ID,
      BRIDGE_INSTANCE_ID,
      ROOT_JTI,
      expect.any(String),
    ]);
    expect(storedBinding?.bootstrap_session_config).not.toContain(mcpToken);
    expect(storedBinding?.bootstrap_session_config).not.toContain(bootstrap);
    expect(storedBinding?.bootstrap_session_config).not.toContain(eventToken);
    expect(storedBinding?.bootstrap_session_config).not.toContain(renewalToken);
    expect(storedBinding?.bootstrap_session_config).not.toContain(PLACEHOLDER);
    expect(JSON.stringify(mocks.query.mock.calls)).not.toContain(bootstrap);
    expect(JSON.stringify(mocks.query.mock.calls)).not.toContain(eventToken);
    expect(JSON.stringify(mocks.query.mock.calls)).not.toContain(mcpToken);
    expect(JSON.stringify(mocks.query.mock.calls)).not.toContain(renewalToken);
    const lockedCallQuery = mocks.query.mock.calls.find(([sql]) => (
      String(sql).includes("SELECT c.id") && String(sql).includes("FOR UPDATE OF c")
    ));
    expect(String(lockedCallQuery?.[0])).toContain("c.status = 'active'");
    expect(String(lockedCallQuery?.[0])).not.toContain("dialing");
    expect(mocks.ensureSafeDatabaseRuntimeRole).toHaveBeenCalledTimes(1);
  });

  it("is accepted byte-for-byte by the standalone bridge compiler", async () => {
    const bridgeToken = rootToken();
    const client = new CompilerBootstrapClient({
      appOrigin: APP_ORIGIN,
      now: () => NOW,
      fetchImpl: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        expect(String(input)).toBe(`${APP_ORIGIN}/api/telephony/bridge/session`);
        return POST(new Request(input, init));
      },
    });

    const compiled = await client.createSession({
      sessionId: SESSION_ID,
      bridgeToken,
      accountSid: ACCOUNT_SID,
      callSid: CALL_SID,
      streamSid: STREAM_SID,
      mode: "agent",
      bridgeInstanceId: BRIDGE_INSTANCE_ID,
    });
    expect(compiled).toMatchObject({
      sessionId: SESSION_ID,
      callId: CALL_ID,
      connection,
      provider: "openai",
      model: "gpt-realtime",
      eventCapability: { audience: "telephony_events", purpose: "event_journal" },
      mcpCapability: { audience: "bridge_mcp", purpose: "tool_invocation" },
      renewalCapability: { audience: "bridge_refresh", purpose: "capability_rotation" },
      activeCatalogAuthority: { catalogDigest: CATALOG_DIGEST, capabilityEpoch: 7 },
      rotation: 0,
      rotationEndpoint: "/api/telephony/bridge/capabilities/rotate",
      refreshAfter: "2026-07-16T20:25:00.000Z",
    });
    expect(new Set([
      compiled.eventCapability.token,
      compiled.mcpCapability.token,
      compiled.renewalCapability.token,
    ]).size).toBe(3);
    expect(() => validateProviderConfig({
      provider: compiled.provider,
      wsUrl: compiled.wsUrl,
      model: compiled.model,
      sessionUpdate: compiled.sessionUpdate,
    }, { allowedClientTools: ["capability_gateway"] })).not.toThrow();
  });

  it("makes an exact retry byte-stable while rejecting cross-session replay", async () => {
    const token = rootToken();
    const first = await POST(request(body(), { token }));
    const firstBytes = await first.text();
    expect(first.status).toBe(200);

    mocks.voiceSessionSpecForCall.mockResolvedValue({
      provider: "openai",
      model: "provider-config-changed-after-first-use",
      voice: "alloy",
      settings: {},
      instructions: "Changed after the binding was committed.",
      mcpServers: [],
      toolProxyUrl: `${APP_ORIGIN}/api/mcp`,
      toolProxyToken: "changed",
      activeCatalogAuthority: {
        catalogDigest: "d".repeat(64),
        capabilityEpoch: 8,
        runtimeDigest: "e".repeat(64),
        stateRevision: 12,
      },
    });
    const retry = await POST(request(body(), { token }));
    const retryBytes = await retry.text();
    expect(retry.status).toBe(200);
    expect(retryBytes).toBe(firstBytes);

    const collision = await POST(request(body({ bridge_instance_id: "different-bridge-instance" }), { token }));
    expect(collision.status).toBe(409);
    expect(await collision.json()).toEqual({ error: "stream identity or capability replay rejected" });

    const otherSession = "bridge-session-2";
    expect((await POST(request(body({ session_id: otherSession }), {
      token,
      idempotencyKey: otherSession,
    }))).status).toBe(409);
    expect((await POST(request(body({
      connection: { ...connection, stream_sid: `MZ${"4".repeat(32)}` },
    }), { token }))).status).toBe(409);
    expect((await POST(request(body(), { token: rootToken("s".repeat(22)) }))).status).toBe(409);

    const bindingInserts = mocks.query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO telephony_stream_bindings"));
    const consumptionInserts = mocks.query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO telephony_capability_consumptions"));
    expect(bindingInserts).toHaveLength(1);
    expect(consumptionInserts).toHaveLength(1);
  });

  it("never turns literal placeholder text into a provider-visible bearer", async () => {
    mocks.voiceSessionSpecForCall.mockResolvedValue({
      provider: "openai",
      model: PLACEHOLDER,
      voice: "alloy",
      settings: {},
      instructions: `Say this literal safely: ${PLACEHOLDER}`,
      mcpServers: [{ label: "hacc-tools", serverUrl: `${APP_ORIGIN}/api/mcp` }],
      toolProxyUrl: `${APP_ORIGIN}/api/mcp`,
      toolProxyToken: "old",
      activeCatalogAuthority: {
        catalogDigest: CATALOG_DIGEST,
        capabilityEpoch: 7,
        runtimeDigest: "e".repeat(64),
        stateRevision: 11,
      },
    });
    const response = await POST(request(body()));
    const payload = await response.json();
    const mcpToken = payload.mcp_capability.token as string;

    expect(payload.session_update.session.instructions).toBe(`Say this literal safely: ${PLACEHOLDER}`);
    expect(payload.session_update.session.instructions).not.toContain(mcpToken);
    expect(payload.model).toBe(PLACEHOLDER);
    expect(payload.session_update.session.model).toBe(PLACEHOLDER);
    expect(payload.session_update.session.tools).toHaveLength(1);
    expect(payload.session_update.session.tools[0]).toMatchObject({
      type: "function",
      name: "capability_gateway",
    });
    expect(JSON.stringify(payload.session_update)).not.toContain(mcpToken);
    expect(JSON.stringify(payload.session_update)).not.toContain("authorization");
    expect(() => validateProviderConfig({
      provider: payload.provider,
      wsUrl: payload.ws_url,
      model: payload.model,
      sessionUpdate: payload.session_update,
    }, { allowedClientTools: ["capability_gateway"] })).not.toThrow();
  });

  it("forces provider-local tools even when agent settings request experimental direct MCP", async () => {
    mocks.voiceSessionSpecForCall.mockResolvedValue({
      provider: "openai",
      model: "gpt-realtime",
      voice: "alloy",
      settings: {
        experimental_provider_direct_mcp: { enabled: true, allow_consequential: true },
      },
      instructions: "Never disclose provider credentials.",
      mcpServers: [{
        label: "external",
        serverUrl: "https://external-mcp.example.test/rpc",
        authorization: "Bearer third-party-secret",
      }],
      toolProxyUrl: `${APP_ORIGIN}/api/mcp`,
      toolProxyToken: "old",
      activeCatalogAuthority: {
        catalogDigest: CATALOG_DIGEST,
        capabilityEpoch: 7,
        runtimeDigest: "e".repeat(64),
        stateRevision: 11,
      },
    });
    const response = await POST(request(body()));
    expect(response.status).toBe(200);
    const payload = await response.json();
    const providerWire = JSON.stringify(payload.session_update);
    expect(payload.session_update.session.tools).toHaveLength(1);
    expect(payload.session_update.session.tools[0]).toMatchObject({
      type: "function",
      name: "capability_gateway",
    });
    expect(providerWire).not.toContain('"type":"mcp"');
    expect(providerWire).not.toContain("third-party-secret");
    expect(providerWire).not.toContain(payload.mcp_capability.token);
    expect(() => validateProviderConfig({
      provider: payload.provider,
      wsUrl: payload.ws_url,
      model: payload.model,
      sessionUpdate: payload.session_update,
    }, { allowedClientTools: ["capability_gateway"] })).not.toThrow();
  });

  it("returns 404 before provider compilation for a missing call", async () => {
    mocks.qOne.mockResolvedValue(null);
    const response = await POST(request(body()));

    expect(response.status).toBe(404);
    expect(mocks.loadActiveAgent).not.toHaveBeenCalled();
    expect(mocks.voiceSessionSpecForCall).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("rejects a merely dialing call at the preflight boundary", async () => {
    mocks.qOne.mockImplementationOnce(async (sql: string) => {
      expect(sql).toContain("c.status = 'active'");
      expect(sql).not.toContain("dialing");
      // A row whose durable status is still `dialing` cannot satisfy the
      // active-only predicate and is therefore represented by no result.
      return null;
    });

    const response = await POST(request(body()));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "call not found" });
    expect(mocks.qOne).toHaveBeenCalledTimes(1);
    expect(mocks.loadActiveAgent).not.toHaveBeenCalled();
    expect(mocks.voiceSessionSpecForCall).not.toHaveBeenCalled();
    expect(mocks.buildProviderSessionUpdate).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("rejects a provider unsupported by the μ-law standalone bridge before binding", async () => {
    mocks.serverRealtimeEndpoint.mockReturnValue({
      provider: "gemini",
      wsUrl: "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
    });
    const response = await POST(request(body()));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "provider unsupported by standalone bridge" });
    expect(mocks.buildProviderSessionUpdate).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
