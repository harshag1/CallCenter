import { describe, expect, it, vi } from "vitest";
import type {
  RealtimeProviderAdapter,
  VoiceSessionSpec,
} from "../realtime/types";
import { BUILT_IN_REALTIME_PROVIDER_PLUGINS } from "../realtime/plugins/builtins";
import {
  RealtimeProviderPluginError,
  createRealtimeProviderPluginRegistry,
  runRealtimeProviderPluginConformance,
  wrapLegacyRealtimeProviderAdapter,
  type RealtimeProviderManifest,
  type RealtimeProviderPlugin,
  type RealtimeProviderPluginSessionSpec,
} from "../realtime/plugins";

const PCM = {
  id: "pcm-24k-mono",
  input: { encoding: "pcm-s16le", sampleRateHz: 24_000, channels: 1 },
  output: { encoding: "pcm-s16le", sampleRateHz: 24_000, channels: 1 },
} as const;

const PCMU = {
  id: "pcmu-8k-mono",
  input: { encoding: "pcmu", sampleRateHz: 8_000, channels: 1 },
  output: { encoding: "pcmu", sampleRateHz: 8_000, channels: 1 },
} as const;

const SESSION: RealtimeProviderPluginSessionSpec = {
  providerId: "community-sip",
  model: "community-realtime-v1",
  voice: "river",
  instructions: "Stay inside the current flow objective.",
  settings: {},
  mcpServers: [],
  toolAuthority: {
    proxyUrl: "https://app.example.test/api/mcp",
    proxyToken: "call-scoped-token",
    activeCatalog: {
      catalogDigest: "c".repeat(64),
      capabilityEpoch: 4,
      runtimeDigest: "r".repeat(64),
      stateRevision: 9,
    },
  },
};

function manifest(id = "community-sip"): RealtimeProviderManifest {
  return {
    contractVersion: "1.0",
    id,
    label: `${id} realtime`,
    docsUrl: `https://providers.example.test/${id}`,
    defaultModel: `${id}-realtime-v1`,
    defaultVoice: "river",
    environment: [`${id.replaceAll("-", "_").toUpperCase()}_TOKEN`],
    lifecycle: { maturity: "experimental", since: "2026-07-19" },
    transports: {
      browser: [{ kind: "websocket", mediaProfileIds: [PCM.id] }],
      server: [{ kind: "websocket", mediaProfileIds: [PCM.id, PCMU.id] }],
    },
    mediaProfiles: [PCM, PCMU],
    telephony: {
      support: "transcoding-bridge",
      ingressMediaProfileIds: [PCMU.id],
      providerMediaProfileIds: [PCM.id],
      notes: ["The community bridge owns PSTN signaling and media conversion."],
    },
    tools: {
      delivery: "local-gateway",
      normalizedCalls: true,
      streamedArguments: true,
    },
    normalization: {
      eventSchemaVersion: 1,
      input: "wire-events",
      terminalResponseProvenance: true,
      toolCallBatching: "batch",
    },
    metering: {
      usage: "provider-reported",
      rawUsageRetained: true,
      evidence: "wire-observations",
    },
  };
}

function communityPlugin(
  id = "community-sip",
  hooks: {
    validate?: () => void;
    create?: () => void;
  } = {},
): RealtimeProviderPlugin {
  const providerManifest = manifest(id);
  const factory = (mode: "browser" | "server") => ({
    async create(
      request: Parameters<NonNullable<RealtimeProviderPlugin["browser"]>["create"]>[0],
      context: Parameters<NonNullable<RealtimeProviderPlugin["browser"]>["create"]>[1],
    ) {
      hooks.create?.();
      const credential = await context.readCredential(providerManifest.environment[0]);
      return {
        providerId: id,
        mode,
        transport: request.transport,
        mediaProfileId: request.mediaProfileId,
        handle: Object.freeze({
          authenticated: credential.startsWith("conformance-only:")
            || credential === "fake-provider-token",
        }),
      } as const;
    },
  });
  return {
    manifest: providerManifest,
    validateSession(session) {
      hooks.validate?.();
      const issues = [];
      if (session.providerId !== id) {
        issues.push({
          path: "providerId",
          code: "provider_mismatch",
          message: `expected ${id}`,
        });
      }
      if (!session.instructions.trim()) {
        issues.push({
          path: "instructions",
          code: "required",
          message: "instructions are required",
        });
      }
      return issues.length
        ? { ok: false, issues }
        : { ok: true, session };
    },
    browser: factory("browser"),
    server: factory("server"),
    createEventNormalizer() {
      return {
        push(input) {
          if (!input || typeof input !== "object") throw new Error("wire event must be an object");
          const event = input as Record<string, unknown>;
          if (event.type === "tool.batch") {
            return [{
              schemaVersion: 1,
              providerId: id,
              type: "tool.calls",
              receivedAtMs: 1_700_000_000_000,
              wireType: "tool.batch",
              responseId: String(event.responseId),
              toolCalls: [{
                callId: String(event.callId),
                responseId: String(event.responseId),
                name: String(event.name),
                argumentsText: String(event.arguments),
                argumentsJson: JSON.parse(String(event.arguments)),
                terminalWireType: "tool.batch",
              }],
              data: Object.freeze({}),
            }];
          }
          return [{
            schemaVersion: 1,
            providerId: id,
            type: String(event.type),
            receivedAtMs: 1_700_000_000_000,
            wireType: String(event.type),
            data: Object.freeze({ ...event }),
          }];
        },
      };
    },
    encodeToolResults(results) {
      return {
        type: "tool.results",
        results: results.map(({ callId, output }) => ({ callId, output })),
      };
    },
  };
}

describe("realtime provider plugin contract", () => {
  it("registers a synthetic fourth provider without editing a core provider switch", () => {
    const registry = createRealtimeProviderPluginRegistry([
      ...BUILT_IN_REALTIME_PROVIDER_PLUGINS,
    ]);
    registry.register(communityPlugin());

    expect(registry.manifests().map(({ id }) => id))
      .toEqual(["community-sip", "gemini", "openai", "xai"]);
    expect(registry.get("community-sip").manifest).toMatchObject({
      contractVersion: "1.0",
      defaultModel: "community-sip-realtime-v1",
      telephony: { support: "transcoding-bridge" },
      metering: { evidence: "wire-observations" },
    });
  });

  it("preflights unsupported transport and media before validation, credentials, factory, or network", async () => {
    const validate = vi.fn();
    const create = vi.fn();
    const credential = vi.fn(async () => "must-not-be-read");
    const fetchMock = vi.fn<typeof fetch>();
    const registry = createRealtimeProviderPluginRegistry([
      communityPlugin("community-sip", { validate, create }),
    ]);

    await expect(registry.createConnection(
      "community-sip",
      "browser",
      "webrtc",
      PCM.id,
      SESSION,
      { readCredential: credential, fetch: fetchMock },
    )).rejects.toMatchObject({ code: "unsupported_transport" });
    await expect(registry.createConnection(
      "community-sip",
      "browser",
      "websocket",
      PCMU.id,
      SESSION,
      { readCredential: credential, fetch: fetchMock },
    )).rejects.toMatchObject({ code: "unsupported_media" });

    expect(validate).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(credential).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates a session before credentials and restricts factories to declared credentials", async () => {
    const credential = vi.fn(async () => "fake-provider-token");
    const registry = createRealtimeProviderPluginRegistry([communityPlugin()]);
    const invalid = { ...SESSION, instructions: "" };

    await expect(registry.createConnection(
      "community-sip",
      "browser",
      "websocket",
      PCM.id,
      invalid,
      { readCredential: credential },
    )).rejects.toMatchObject({ code: "invalid_session" });
    expect(credential).not.toHaveBeenCalled();

    const connection = await registry.createConnection(
      "community-sip",
      "server",
      "websocket",
      PCMU.id,
      SESSION,
      { readCredential: credential },
    );
    expect(connection).toMatchObject({
      providerId: "community-sip",
      mode: "server",
      transport: "websocket",
      mediaProfileId: PCMU.id,
      handle: { authenticated: true },
    });
    expect(credential).toHaveBeenCalledWith("COMMUNITY_SIP_TOKEN");

    const undeclared = communityPlugin();
    const originalFactory = undeclared.browser!;
    const hostile = {
      ...undeclared,
      browser: {
        async create(request, context) {
          await context.readCredential("UNDECLARED_ROOT_KEY");
          return originalFactory.create(request, context);
        },
      },
    } satisfies RealtimeProviderPlugin;
    const hostileRegistry = createRealtimeProviderPluginRegistry([hostile]);
    await expect(hostileRegistry.createConnection(
      "community-sip",
      "browser",
      "websocket",
      PCM.id,
      SESSION,
      { readCredential: credential },
    )).rejects.toMatchObject({ code: "undeclared_credential" });
  });

  it("validates normalized events and tool-result batches at the registry boundary", () => {
    const registry = createRealtimeProviderPluginRegistry([communityPlugin()]);
    const normalizer = registry.createEventNormalizer("community-sip", PCM.id);
    expect(normalizer.push({
      type: "tool.batch",
      callId: "call-1",
      responseId: "response-1",
      name: "membership.lookup",
      arguments: "{}",
    })).toMatchObject([{
      providerId: "community-sip",
      type: "tool.calls",
      toolCalls: [{ callId: "call-1", responseId: "response-1" }],
    }]);
    expect(registry.encodeToolResults("community-sip", [
      { callId: "call-1", output: { ok: true } },
    ])).toEqual({
      type: "tool.results",
      results: [{ callId: "call-1", output: { ok: true } }],
    });
    expect(() => registry.encodeToolResults("community-sip", [
      { callId: "call-1", output: "first" },
      { callId: "call-1", output: "replay" },
    ])).toThrow(/duplicate result/);

    const invalid = {
      ...communityPlugin("bad-normalizer"),
      createEventNormalizer: () => ({
        push: () => [{
          schemaVersion: 1 as const,
          providerId: "different-provider",
          type: "tool.calls",
          receivedAtMs: Date.now(),
          wireType: "tool.calls",
          data: {},
        }],
      }),
    };
    const invalidRegistry = createRealtimeProviderPluginRegistry([invalid]);
    expect(() => invalidRegistry.createEventNormalizer(
      "bad-normalizer",
      PCM.id,
    ).push({})).toThrow(/invalid event/);
  });

  it("detaches manifest collections and registers batches atomically", () => {
    const input = communityPlugin();
    const environment = input.manifest.environment as string[];
    const registry = createRealtimeProviderPluginRegistry([input]);
    environment.push("MUTATED_AFTER_REGISTRATION");
    expect(registry.get("community-sip").manifest.environment)
      .toEqual(["COMMUNITY_SIP_TOKEN"]);
    expect(Object.isFrozen(registry.get("community-sip").manifest.mediaProfiles)).toBe(true);

    const empty = createRealtimeProviderPluginRegistry();
    expect(() => empty.registerAll([
      communityPlugin("first-provider"),
      communityPlugin("first-provider"),
    ])).toThrowError(RealtimeProviderPluginError);
    expect(empty.manifests()).toEqual([]);
  });

  it("rejects mismatched factory declarations, unknown media, and credential-bearing docs URLs", () => {
    const valid = communityPlugin();
    expect(() => createRealtimeProviderPluginRegistry([{
      ...valid,
      browser: undefined,
    }])).toThrow(/transport\/factory declarations disagree/);
    expect(() => createRealtimeProviderPluginRegistry([{
      ...valid,
      browser: { create: undefined as never },
    }])).toThrow(/transport\/factory declarations disagree/);
    expect(() => createRealtimeProviderPluginRegistry([{
      ...valid,
      manifest: {
        ...valid.manifest,
        transports: {
          ...valid.manifest.transports,
          browser: [{ kind: "websocket", mediaProfileIds: ["missing-profile"] }],
        },
      },
    }])).toThrow(/unknown media profile/);
    expect(() => createRealtimeProviderPluginRegistry([{
      ...valid,
      manifest: {
        ...valid.manifest,
        docsUrl: "https://token:secret@providers.example.test/private",
      },
    }])).toThrow(/public HTTPS/);
  });

  it("rejects contradictory normalized tool arguments and cross-response identities", () => {
    const malformed = (call: Record<string, unknown>) => ({
      ...communityPlugin("contradictory-provider"),
      createEventNormalizer: () => ({
        push: () => [{
          schemaVersion: 1 as const,
          providerId: "contradictory-provider",
          type: "tool.calls",
          receivedAtMs: Date.now(),
          wireType: "tool.batch",
          responseId: "response-1",
          toolCalls: [{
            callId: "call-1",
            responseId: "response-1",
            name: "membership.lookup",
            argumentsText: "{\"member_id\":\"m-1\"}",
            argumentsJson: { member_id: "m-1" },
            terminalWireType: "tool.batch",
            ...call,
          }],
          data: {},
        }],
      }),
    });
    const contradictory = createRealtimeProviderPluginRegistry([
      malformed({ argumentsJson: { member_id: "different" } }),
    ]);
    expect(() => contradictory.createEventNormalizer(
      "contradictory-provider",
      PCM.id,
    ).push({})).toThrow(/contradictory arguments/);

    const crossResponse = createRealtimeProviderPluginRegistry([
      malformed({ responseId: "response-2" }),
    ]);
    expect(() => crossResponse.createEventNormalizer(
      "contradictory-provider",
      PCM.id,
    ).push({})).toThrow(/invalid tool call/);
  });

  it("snapshots legacy adapter metadata before registration", async () => {
    const mutableManifest = structuredClone(manifest("xai"));
    const createServerConnection = vi.fn(async (spec: VoiceSessionSpec) => ({
      provider: "xai" as const,
      model: spec.model,
      voice: spec.voice,
      wsUrl: "wss://legacy.example.test/realtime",
      headers: {},
      sessionUpdate: {},
      wireProtocol: "openai-realtime" as const,
    }));
    const adapter = {
      id: "xai" as const,
      label: "Mutable legacy adapter",
      defaultModel: "legacy-model",
      defaultVoice: "ara",
      env: ["XAI_API_KEY"],
      capabilities: {
        browser: "websocket" as const,
        telephony: "native-pcmu" as const,
        remoteMcp: true,
        clientFunctions: true,
        sessionResumption: { supported: true, enabledByDefault: false },
        notes: [],
      },
      buildSessionUpdate: () => ({}),
      createBrowserConnection: vi.fn(),
      createServerConnection,
    };
    const wrapped = wrapLegacyRealtimeProviderAdapter({
      adapter,
      manifest: {
        ...mutableManifest,
        environment: ["XAI_API_KEY"],
        mediaProfiles: [PCM],
        transports: {
          browser: [],
          server: [{ kind: "websocket", mediaProfileIds: [PCM.id] }],
        },
        telephony: {
          support: "native-media",
          ingressMediaProfileIds: [PCM.id],
          providerMediaProfileIds: [PCM.id],
          notes: [],
        },
      },
      createEventNormalizer: () => ({ push: () => [] }),
      encodeToolResults: (results) => results,
    });
    adapter.createServerConnection = vi.fn(async () => {
      throw new Error("mutated adapter escaped snapshot");
    });
    (mutableManifest.mediaProfiles[0].input as { sampleRateHz: number }).sampleRateHz = 48_000;

    const registry = createRealtimeProviderPluginRegistry([wrapped]);
    await registry.createConnection(
      "xai",
      "server",
      "websocket",
      PCM.id,
      { ...SESSION, providerId: "xai" },
      { readCredential: async () => "unused" },
    );
    expect(createServerConnection).toHaveBeenCalledOnce();
  });

  it("ships an executable, injected-network-blocked smoke conformance kit", async () => {
    const report = await runRealtimeProviderPluginConformance(
      communityPlugin(),
      {
        validSession: SESSION,
        invalidSession: { ...SESSION, instructions: "" },
        supportedConnection: {
          mode: "browser",
          transport: "websocket",
          mediaProfileId: PCM.id,
        },
        unsupportedConnection: {
          mode: "browser",
          transport: "webrtc",
          mediaProfileId: PCM.id,
        },
        normalization: {
          mediaProfileId: PCM.id,
          inputEvents: [
            { type: "session.ready" },
            {
              type: "tool.batch",
              callId: "call-1",
              responseId: "response-1",
              name: "membership.lookup",
              arguments: "{\"member_id\":\"m-1\"}",
            },
          ],
          expectedEventTypes: ["session.ready", "tool.calls"],
        },
        toolResults: [{ callId: "call-1", output: { status: "active" } }],
      },
    );

    expect(report).toMatchObject({
      contractVersion: "1.0",
      providerId: "community-sip",
      passed: true,
    });
    expect(report.checks).toHaveLength(5);
    expect(report.checks.every(({ passed }) => passed)).toBe(true);
  });

  it("wraps the current adapter shape while preserving exact transport and media selection", async () => {
    const createServerConnection = vi.fn(async (
      spec: VoiceSessionSpec,
      audio: "pcm" | "pcmu",
    ) => ({
      provider: "xai" as const,
      model: spec.model,
      voice: spec.voice,
      wsUrl: "wss://legacy.example.test/realtime",
      headers: {},
      sessionUpdate: {},
      wireProtocol: "openai-realtime" as const,
      selectedAudio: audio,
    }));
    const adapter: RealtimeProviderAdapter = {
      id: "xai",
      label: "Legacy xAI test adapter",
      defaultModel: "legacy-model",
      defaultVoice: "ara",
      env: ["XAI_API_KEY"],
      capabilities: {
        browser: "websocket",
        telephony: "native-pcmu",
        remoteMcp: true,
        clientFunctions: true,
        sessionResumption: { supported: true, enabledByDefault: false },
        notes: [],
      },
      buildSessionUpdate: () => ({}),
      createBrowserConnection: vi.fn(),
      createServerConnection,
    };
    const wrapped = wrapLegacyRealtimeProviderAdapter({
      adapter,
      manifest: {
        ...manifest("xai"),
        environment: ["XAI_API_KEY"],
        transports: {
          browser: [],
          server: [{ kind: "websocket", mediaProfileIds: [PCM.id, PCMU.id] }],
        },
        telephony: {
          support: "native-media",
          ingressMediaProfileIds: [PCMU.id],
          providerMediaProfileIds: [PCMU.id],
          notes: [],
        },
      },
      createEventNormalizer: () => ({ push: () => [] }),
      encodeToolResults: (results) => results,
    });
    const registry = createRealtimeProviderPluginRegistry([wrapped]);
    const connection = await registry.createConnection(
      "xai",
      "server",
      "websocket",
      PCMU.id,
      { ...SESSION, providerId: "xai" },
      { readCredential: async () => "unused-by-legacy-wrapper" },
    );

    expect(connection).toMatchObject({
      providerId: "xai",
      mode: "server",
      transport: "websocket",
      mediaProfileId: PCMU.id,
    });
    expect(createServerConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "xai",
        model: "community-realtime-v1",
        toolProxyUrl: SESSION.toolAuthority.proxyUrl,
      }),
      "pcmu",
    );
  });
});
