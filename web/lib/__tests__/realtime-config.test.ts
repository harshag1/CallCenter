import { describe, expect, it, vi } from "vitest";
import { resolveVoiceProviderConfig } from "../realtime/config";
import { geminiAdapter } from "../realtime/providers/gemini";
import { openaiAdapter } from "../realtime/providers/openai";
import { xaiAdapter } from "../realtime/providers/xai";

const TOOL_PROXY_ROTATION = {
  endpoint: "/api/voice/capabilities/rotate" as const,
  callId: "00000000-0000-4000-8000-000000000001",
  rotation: 0,
  renewalToken: `renewal.${"r".repeat(96)}`,
  refreshAfter: "2099-01-01T00:25:00.000Z",
  expiresAt: "2099-01-01T00:30:00.000Z",
};

describe("realtime provider configuration", () => {
  it("keeps existing agents on xAI by default", () => {
    expect(resolveVoiceProviderConfig({}, "ara")).toEqual({
      provider: "xai",
      model: "grok-voice-think-fast-1.0",
      voice: "ara",
      settings: {},
    });
    expect(xaiAdapter.defaultModel).toBe("grok-voice-think-fast-1.0");
  });

  it("uses a mutable xAI alias only when it is an explicit override", () => {
    expect(resolveVoiceProviderConfig({
      voice_provider: "xai",
      voice_model: "grok-voice-latest",
    }, "ara")).toMatchObject({
      provider: "xai",
      model: "grok-voice-latest",
    });
  });

  it("uses the current OpenAI realtime default without leaking reserved settings", () => {
    expect(resolveVoiceProviderConfig({
      voice_provider: "openai",
      voice_model: "gpt-realtime-2.1",
      provider_settings: { reasoning: { effort: "low" } },
      max_response_output_tokens: 512,
    }, "ara")).toEqual({
      provider: "openai",
      model: "gpt-realtime-2.1",
      voice: "marin",
      settings: {
        max_response_output_tokens: 512,
        reasoning: { effort: "low" },
      },
    });
  });

  it("keeps custom Gemini model and voice names configurable", () => {
    expect(resolveVoiceProviderConfig({
      voice_provider: "gemini",
      voice_model: "gemini-future-live",
    }, "Aoede")).toMatchObject({
      provider: "gemini",
      model: "gemini-future-live",
      voice: "Aoede",
    });
  });

  it("distinguishes provider-native resumption support from its safe default", () => {
    expect(geminiAdapter.capabilities.sessionResumption)
      .toEqual({ supported: true, enabledByDefault: false });
    expect(xaiAdapter.capabilities.sessionResumption)
      .toEqual({ supported: true, enabledByDefault: false });
    expect(openaiAdapter.capabilities.sessionResumption)
      .toEqual({ supported: false, enabledByDefault: false });
  });

  it("preserves xAI's evolving built-in and custom voice IDs", () => {
    expect(resolveVoiceProviderConfig({ voice_provider: "xai" }, "future-xai-voice"))
      .toMatchObject({ provider: "xai", voice: "future-xai-voice" });
  });

  it("preserves a canonical OpenAI custom voice ID", () => {
    expect(resolveVoiceProviderConfig({ voice_provider: "openai" }, "voice_1234"))
      .toMatchObject({ provider: "openai", voice: "voice_1234" });
  });

  it("carries the scoped local proxy through both browser adapters without putting it in provider payloads", async () => {
    const priorXaiKey = process.env.XAI_API_KEY;
    const priorOpenaiKey = process.env.OPENAI_API_KEY;
    process.env.XAI_API_KEY = "xai-provider-key";
    process.env.OPENAI_API_KEY = "openai-provider-key";
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      void _init;
      const url = String(input);
      return new Response(JSON.stringify(url.includes("api.openai.com")
        ? { client_secret: { value: "openai-browser-secret" } }
        : { value: "xai-browser-secret" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const toolProxyUrl = "https://app.example.test/api/mcp";
    const toolProxyToken = "scope-token-must-stay-local";
    const common = {
      instructions: "Use only the local gateway.",
      settings: {},
      mcpServers: [{
        label: "legacy-gateway",
        serverUrl: toolProxyUrl,
        authorization: `Bearer ${toolProxyToken}`,
      }],
      toolProxyUrl,
      toolProxyToken,
      toolProxyRotation: TOOL_PROXY_ROTATION,
      activeCatalogAuthority: {
        catalogDigest: "c".repeat(64),
        capabilityEpoch: 1,
        runtimeDigest: "d".repeat(64),
        stateRevision: 1,
      },
    };
    try {
      const [xai, openai] = await Promise.all([
        xaiAdapter.createBrowserConnection({
          ...common,
          provider: "xai",
          model: "grok-voice-think-fast-1.0",
          voice: "ara",
        }),
        openaiAdapter.createBrowserConnection({
          ...common,
          provider: "openai",
          model: "gpt-realtime-2.1",
          voice: "marin",
        }),
      ]);
      expect(xai).toMatchObject({ toolProxyUrl, toolProxyToken });
      expect(openai).toMatchObject({ toolProxyUrl, toolProxyToken });
      expect(xai.toolProxyUrl).toBe(toolProxyUrl);
      expect(xai.toolProxyToken).toBe(toolProxyToken);
      expect(openai.toolProxyUrl).toBe(toolProxyUrl);
      expect(openai.toolProxyToken).toBe(toolProxyToken);
      expect(xai.toolProxyRotation).toEqual(TOOL_PROXY_ROTATION);
      expect(openai.toolProxyRotation).toEqual(TOOL_PROXY_ROTATION);
      for (const [, init] of fetchMock.mock.calls) {
        expect(String(init?.body ?? "")).not.toContain(toolProxyUrl);
        expect(String(init?.body ?? "")).not.toContain(toolProxyToken);
        expect(String(init?.body ?? "")).not.toContain(TOOL_PROXY_ROTATION.renewalToken);
      }
    } finally {
      vi.unstubAllGlobals();
      if (priorXaiKey === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = priorXaiKey;
      if (priorOpenaiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = priorOpenaiKey;
    }
  });

  it("rejects local proxy disclosure before either browser provider is contacted", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const local = {
      instructions: "Use only the local gateway.",
      settings: {
        experimental_provider_direct_mcp: { enabled: true, allow_consequential: true },
      },
      toolProxyUrl: "https://app.example.test/api/mcp",
      toolProxyToken: "call-scoped-local-secret",
      toolProxyRotation: TOOL_PROXY_ROTATION,
      activeCatalogAuthority: {
        catalogDigest: "c".repeat(64),
        capabilityEpoch: 1,
        runtimeDigest: "d".repeat(64),
        stateRevision: 1,
      },
      mcpServers: [{
        label: "callcenter",
        serverUrl: "https://app.example.test/api/mcp",
        authorization: "Bearer call-scoped-local-secret",
      }],
    };
    try {
      await expect(openaiAdapter.createBrowserConnection({
        ...local,
        provider: "openai",
        model: "gpt-realtime-2.1",
        voice: "marin",
      })).rejects.toThrow(/same-origin or local endpoint/);
      await expect(xaiAdapter.createBrowserConnection({
        ...local,
        provider: "xai",
        model: "grok-voice-think-fast-1.0",
        voice: "ara",
      })).rejects.toThrow(/same-origin or local endpoint/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
