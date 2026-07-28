import { describe, expect, it, vi } from "vitest";
import {
  RealtimeProviderRegistry,
  RealtimeProviderRegistryError,
  buildProviderSessionUpdate,
  providerCatalog,
  registerRealtimeProvider,
  realtimeProvider,
  serverRealtimeEndpoint,
  unregisterRealtimeProvider,
  type RealtimeProviderRegistration,
  type RegisteredVoiceSessionSpec,
} from "../realtime/registry";

const SESSION = {
  provider: "community-sip",
  model: "community-realtime-v1",
  voice: "river",
  settings: {},
  instructions: "Stay inside the current flow objective.",
  mcpServers: [],
  toolProxyUrl: "https://app.example.test/api/mcp",
  toolProxyToken: "call-scoped-token",
  activeCatalogAuthority: {
    catalogDigest: "c".repeat(64),
    capabilityEpoch: 4,
    runtimeDigest: "r".repeat(64),
    stateRevision: 9,
  },
} satisfies RegisteredVoiceSessionSpec<"community-sip">;

function adapter<const Id extends string = "community-sip">(
  id: Id = "community-sip" as Id,
  overrides: Partial<RealtimeProviderRegistration<Id>> = {},
): RealtimeProviderRegistration<Id> {
  return {
    id,
    label: "Community SIP",
    defaultModel: "community-realtime-v1",
    defaultVoice: "river",
    env: ["COMMUNITY_SIP_TOKEN"],
    capabilities: {
      browser: "websocket",
      telephony: "native-pcmu",
      remoteMcp: false,
      clientFunctions: true,
      sessionResumption: {
        supported: false,
        enabledByDefault: false,
      },
      notes: ["A self-hosted example adapter."],
    },
    async createBrowserConnection(spec) {
      return {
        provider: id,
        model: spec.model,
        voice: spec.voice,
        transport: "websocket",
        wsUrl: "wss://voice.example.test/browser",
        token: "ephemeral-only",
      };
    },
    async createServerConnection(spec) {
      return {
        provider: id,
        model: spec.model,
        voice: spec.voice,
        wsUrl: "wss://voice.example.test/server",
        headers: { Authorization: "Bearer server-only" },
        sessionUpdate: { type: "session.update" },
        wireProtocol: "openai-realtime",
      };
    },
    buildSessionUpdate(spec, audio) {
      return { provider: spec.provider, model: spec.model, audio };
    },
    serverRealtimeEndpoint(spec) {
      return {
        provider: id,
        wsUrl: `wss://voice.example.test/realtime?model=${encodeURIComponent(spec.model)}`,
      };
    },
    ...overrides,
  };
}

describe("realtime provider runtime registry", () => {
  it("preserves the three protected built-ins in a deterministic public catalog", () => {
    expect(providerCatalog().map(({ id }) => id)).toEqual(["xai", "openai", "gemini"]);
    expect(realtimeProvider("openai")).toMatchObject({
      id: "openai",
      capabilities: { browser: "webrtc", telephony: "native-pcmu" },
    });

    const openaiSession = {
      ...SESSION,
      provider: "openai",
    } satisfies RegisteredVoiceSessionSpec<"openai">;
    expect(buildProviderSessionUpdate(openaiSession, "pcmu")).toMatchObject({
      type: "session.update",
    });
    expect(serverRealtimeEndpoint(openaiSession)).toEqual({
      provider: "openai",
      wsUrl: "wss://api.openai.com/v1/realtime?model=community-realtime-v1",
    });

    const geminiSession = {
      ...SESSION,
      provider: "gemini",
    } satisfies RegisteredVoiceSessionSpec<"gemini">;
    expect(() => serverRealtimeEndpoint(geminiSession)).toThrowError(
      expect.objectContaining({ code: "capability_mismatch" }),
    );
  });

  it("registers, resolves, and unregisters a typed self-hosted provider", async () => {
    const registry = new RealtimeProviderRegistry();
    const input = adapter();
    const registered = registry.register(input);

    expect(registry.has("community-sip")).toBe(true);
    expect(registry.catalog().map(({ id }) => id)).toEqual(["community-sip"]);
    expect(registered).not.toBe(input);
    expect(Object.isFrozen(registered)).toBe(true);
    expect(Object.isFrozen(registered.env)).toBe(true);
    expect(Object.isFrozen(registered.capabilities)).toBe(true);
    expect(Object.isFrozen(registered.capabilities.notes)).toBe(true);

    await expect(registry.createBrowserConnection(SESSION)).resolves.toMatchObject({
      provider: "community-sip",
      model: "community-realtime-v1",
      transport: "websocket",
    });
    await expect(registry.createServerConnection(SESSION, "pcmu")).resolves.toMatchObject({
      provider: "community-sip",
      wireProtocol: "openai-realtime",
    });
    expect(registry.buildSessionUpdate(SESSION, "pcmu")).toEqual({
      provider: "community-sip",
      model: "community-realtime-v1",
      audio: "pcmu",
    });
    expect(registry.serverEndpoint(SESSION)).toMatchObject({
      provider: "community-sip",
      wsUrl: expect.stringMatching(/^wss:/),
    });

    expect(registry.unregister("community-sip")).toBe(registered);
    expect(registry.unregister("community-sip")).toBeUndefined();
    expect(() => registry.get("community-sip")).toThrowError(
      expect.objectContaining({ code: "unknown_provider" }),
    );
  });

  it("installs an extension into the application catalog without a core switch edit", () => {
    const installed = registerRealtimeProvider(adapter("launch-voice"));
    try {
      expect(realtimeProvider("launch-voice")).toBe(installed);
      expect(providerCatalog().map(({ id }) => id)).toContain("launch-voice");
    } finally {
      expect(unregisterRealtimeProvider("launch-voice")).toBe(installed);
    }
    expect(providerCatalog().map(({ id }) => id)).not.toContain("launch-voice");
  });

  it("rejects duplicates and rolls back an atomic registerAll batch", () => {
    const registry = new RealtimeProviderRegistry([adapter()]);

    expect(() => registry.register(adapter())).toThrowError(
      expect.objectContaining({ code: "duplicate_provider" }),
    );
    expect(() => registry.registerAll([
      adapter("other-sip"),
      adapter(),
    ])).toThrowError(expect.objectContaining({ code: "duplicate_provider" }));
    expect(registry.has("other-sip")).toBe(false);
    expect(registry.has("community-sip")).toBe(true);
  });

  it("protects built-ins from runtime removal", () => {
    const registry = new RealtimeProviderRegistry([adapter()], {
      protect: ["community-sip"],
    });
    expect(() => registry.unregister("community-sip")).toThrowError(
      expect.objectContaining({ code: "builtin_provider" }),
    );
    expect(registry.has("community-sip")).toBe(true);
  });

  it("fails registration when declared capabilities and hooks disagree", () => {
    const registry = new RealtimeProviderRegistry();
    const noEndpoint = adapter();
    delete noEndpoint.serverRealtimeEndpoint;
    expect(() => registry.register(noEndpoint)).toThrowError(
      expect.objectContaining({ code: "capability_mismatch" }),
    );

    expect(() => registry.register(adapter("transcoding-sip", {
      capabilities: {
        ...adapter().capabilities,
        telephony: "requires-transcoding",
      },
    }))).toThrowError(expect.objectContaining({ code: "capability_mismatch" }));

    expect(() => registry.register(adapter("resumption-lie", {
      capabilities: {
        ...adapter().capabilities,
        sessionResumption: {
          supported: false,
          enabledByDefault: true,
        },
      },
    }))).toThrowError(expect.objectContaining({ code: "capability_mismatch" }));
  });

  it("checks returned connection metadata against registered capabilities", async () => {
    const browserHook = vi.fn(async () => ({
      provider: "community-sip" as const,
      model: SESSION.model,
      voice: SESSION.voice,
      transport: "webrtc" as const,
    }));
    const registry = new RealtimeProviderRegistry([
      adapter("community-sip", { createBrowserConnection: browserHook }),
    ]);

    await expect(registry.createBrowserConnection(SESSION)).rejects.toMatchObject({
      code: "capability_mismatch",
    });
    expect(browserHook).toHaveBeenCalledTimes(1);
  });

  it("keeps credentials out of registered WSS endpoint URLs", async () => {
    const registry = new RealtimeProviderRegistry([
      adapter("credential-url", {
        async createServerConnection(spec) {
          return {
            provider: "credential-url",
            model: spec.model,
            voice: spec.voice,
            wsUrl: "wss://root:secret@voice.example.test/server",
            headers: {},
            sessionUpdate: {},
            wireProtocol: "openai-realtime",
          };
        },
        serverRealtimeEndpoint() {
          return {
            provider: "credential-url",
            wsUrl: "wss://root:secret@voice.example.test/realtime",
          };
        },
      }),
    ]);
    const session = { ...SESSION, provider: "credential-url" } as const;

    await expect(registry.createServerConnection(session, "pcmu")).rejects.toMatchObject({
      code: "capability_mismatch",
    });
    expect(() => registry.serverEndpoint(session)).toThrowError(
      expect.objectContaining({ code: "capability_mismatch" }),
    );
  });

  it("rejects a mismatched session before invoking provider code", async () => {
    const browserHook = vi.fn(adapter().createBrowserConnection);
    const registry = new RealtimeProviderRegistry([
      adapter("community-sip", { createBrowserConnection: browserHook }),
    ]);

    await expect(registry.createBrowserConnection({
      ...SESSION,
      provider: "other-sip",
    })).rejects.toMatchObject({ code: "unknown_provider" });
    expect(browserHook).not.toHaveBeenCalled();
  });

  it("uses stable error identities for operator diagnostics", () => {
    const error = new RealtimeProviderRegistryError(
      "duplicate_provider",
      "duplicate provider",
    );
    expect(error).toMatchObject({
      name: "RealtimeProviderRegistryError",
      code: "duplicate_provider",
    });
  });
});
