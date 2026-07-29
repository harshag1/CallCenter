import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authorizeLocalDeploymentBrowserFunding,
  browserProviderRootFromFundingAuthority,
  isAuthorizedLocalDeploymentBrowserFunding,
} from "./browser-funding-authority";
import { geminiAdapter } from "./providers/gemini";
import { openaiAdapter } from "./providers/openai";
import { xaiAdapter } from "./providers/xai";
import type {
  BrowserProviderFundingAuthority,
  VoiceProviderId,
  VoiceSessionSpec,
} from "./types";

const LOCAL_OPENAI_ROOT = "local-openai-root-that-stays-on-the-server";
const LOCAL_XAI_ROOT = "local-xai-root-that-stays-on-the-server";
const LOCAL_GEMINI_ROOT = "local-gemini-root-that-stays-on-the-server";

const geminiMocks = vi.hoisted(() => ({
  constructorOptions: [] as unknown[],
  createToken: vi.fn(async () => ({ name: "gemini-ephemeral-token" })),
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    readonly authTokens = { create: geminiMocks.createToken };

    constructor(options: unknown) {
      geminiMocks.constructorOptions.push(options);
    }
  },
}));

function enableLoopbackDevelopmentFunding(): void {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("ALLOW_DEV_DEPLOYMENT_FUNDED_AI", "true");
  vi.stubEnv("PUBLIC_ORIGIN", "http://127.0.0.1:3000");
  vi.stubEnv("OPENAI_API_KEY", LOCAL_OPENAI_ROOT);
  vi.stubEnv("XAI_API_KEY", LOCAL_XAI_ROOT);
  vi.stubEnv("GEMINI_API_KEY", LOCAL_GEMINI_ROOT);
}

function session(provider: VoiceProviderId): VoiceSessionSpec {
  return {
    provider,
    model: provider === "openai"
      ? "gpt-realtime-2.1"
      : provider === "xai"
        ? "grok-voice-think-fast-1.0"
        : "gemini-3.1-flash-live-preview",
    voice: provider === "openai" ? "marin" : provider === "xai" ? "ara" : "Kore",
    settings: {},
    instructions: "Stay inside the current flow objective.",
    mcpServers: [],
    toolProxyUrl: "https://app.example.test/api/mcp",
    toolProxyToken: "call-scoped-tool-proxy-token",
    toolProxyRotation: {
      endpoint: "/api/voice/capabilities/rotate",
      callId: "00000000-0000-4000-8000-000000000001",
      rotation: 0,
      renewalToken: `renewal.${"r".repeat(96)}`,
      refreshAfter: "2099-01-01T00:25:00.000Z",
      expiresAt: "2099-01-01T00:30:00.000Z",
    },
    activeCatalogAuthority: {
      catalogDigest: "c".repeat(64),
      capabilityEpoch: 1,
      runtimeDigest: "d".repeat(64),
      stateRevision: 1,
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  geminiMocks.constructorOptions.length = 0;
  geminiMocks.createToken.mockClear();
});

describe("browser realtime local deployment funding authority", () => {
  it("mints only on explicit non-production loopback and never stores the root", () => {
    enableLoopbackDevelopmentFunding();
    const authority = authorizeLocalDeploymentBrowserFunding("openai");
    expect(authority).toEqual({
      source: "local_deployment_authorized",
      provider: "openai",
    });
    expect(Object.isFrozen(authority)).toBe(true);
    expect(isAuthorizedLocalDeploymentBrowserFunding(authority, "openai")).toBe(true);
    expect(JSON.stringify(authority)).not.toContain(LOCAL_OPENAI_ROOT);
    expect(browserProviderRootFromFundingAuthority(
      authority,
      "openai",
      "OPENAI_API_KEY",
    )).toBe(LOCAL_OPENAI_ROOT);
    vi.stubEnv("OPENAI_API_KEY", "rotated-root-must-not-retarget-issued-authority");
    expect(browserProviderRootFromFundingAuthority(
      authority,
      "openai",
      "OPENAI_API_KEY",
    )).toBe(LOCAL_OPENAI_ROOT);
    expect(() => browserProviderRootFromFundingAuthority(
      authority,
      "openai",
      "XAI_API_KEY",
    )).toThrow(/invalid openai browser funding authority/);

    const copy = { ...authority };
    expect(isAuthorizedLocalDeploymentBrowserFunding(copy, "openai")).toBe(false);
    expect(() => browserProviderRootFromFundingAuthority(
      copy,
      "openai",
      "OPENAI_API_KEY",
    )).toThrow(/invalid openai browser funding authority/);
    expect(() => browserProviderRootFromFundingAuthority(
      authority,
      "xai",
      "XAI_API_KEY",
    )).toThrow(/invalid xai browser funding authority/);
  });

  it("rejects flags on production or non-loopback origins", () => {
    enableLoopbackDevelopmentFunding();
    vi.stubEnv("NODE_ENV", "production");
    expect(authorizeLocalDeploymentBrowserFunding("openai")).toBeNull();

    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("PUBLIC_ORIGIN", "https://voice.example.test");
    expect(authorizeLocalDeploymentBrowserFunding("xai")).toBeNull();
  });

  it("rejects forged Gemini local authority and tenant roots", () => {
    const forged = {
      source: "local_deployment_authorized",
      provider: "gemini",
    };
    expect(() => browserProviderRootFromFundingAuthority(
      forged,
      "gemini",
      "GEMINI_API_KEY",
    )).toThrow(/invalid gemini browser funding authority/);
    expect(() => browserProviderRootFromFundingAuthority({
      source: "tenant_byok",
      provider: "gemini",
      apiKey: "tenant-gemini-root-not-supported-in-production",
    }, "gemini", "GEMINI_API_KEY")).toThrow(
      /invalid gemini browser funding authority/,
    );
  });

  it("preserves Gemini's explicit loopback-only mint without reflecting its root", async () => {
    enableLoopbackDevelopmentFunding();
    const authority = authorizeLocalDeploymentBrowserFunding("gemini");
    expect(authority).not.toBeNull();

    const connection = await geminiAdapter.createBrowserConnection(
      session("gemini") as VoiceSessionSpec & { provider: "gemini" },
      authority!,
    );
    expect(connection).toMatchObject({
      provider: "gemini",
      token: "gemini-ephemeral-token",
    });
    expect(geminiMocks.constructorOptions).toEqual([{
      apiKey: LOCAL_GEMINI_ROOT,
      httpOptions: { apiVersion: "v1alpha" },
    }]);
    expect(JSON.stringify(connection)).not.toContain(LOCAL_GEMINI_ROOT);
    expect(JSON.stringify(authority)).not.toContain(LOCAL_GEMINI_ROOT);
  });

  it("does not let direct adapter callers turn omission or a lookalike into env-key spend", async () => {
    enableLoopbackDevelopmentFunding();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const unsafeOpenAI = openaiAdapter.createBrowserConnection as unknown as (
      spec: VoiceSessionSpec,
      authority?: BrowserProviderFundingAuthority<"openai">,
    ) => Promise<unknown>;
    const unsafeXai = xaiAdapter.createBrowserConnection as unknown as (
      spec: VoiceSessionSpec,
      authority?: BrowserProviderFundingAuthority<"xai">,
    ) => Promise<unknown>;

    await expect(unsafeOpenAI(session("openai"))).rejects.toThrow(
      /invalid openai browser funding authority/,
    );
    await expect(unsafeXai(session("xai"), {
      source: "local_deployment_authorized",
      provider: "xai",
    } as unknown as BrowserProviderFundingAuthority<"xai">)).rejects.toThrow(
      /invalid xai browser funding authority/,
    );
    await expect(unsafeOpenAI(session("openai"), {
      source: "tenant_byok",
      provider: "xai",
      apiKey: "mismatched-tenant-xai-root-must-not-fund-openai",
    } as unknown as BrowserProviderFundingAuthority<"openai">)).rejects.toThrow(
      /invalid openai browser funding authority/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
