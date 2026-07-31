import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeLocalDeploymentBrowserFunding } from "./browser-funding-authority";
import { assertBrowserVoiceSessionAdmission } from "./browser-session-admission";
import type {
  BrowserProviderFundingAuthority,
  VoiceProviderId,
} from "./types";

const TENANT_OPENAI_ROOT = "tenant-openai-root-for-origin-admission";
const TENANT_XAI_ROOT = "tenant-xai-root-for-origin-admission";

function enableLocalFunding(): void {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("ALLOW_DEV_DEPLOYMENT_FUNDED_AI", "true");
  vi.stubEnv("PUBLIC_ORIGIN", "http://localhost:3000");
  vi.stubEnv("OPENAI_API_KEY", "local-openai-root-for-origin-admission");
  vi.stubEnv("XAI_API_KEY", "local-xai-root-for-origin-admission");
  vi.stubEnv("GEMINI_API_KEY", "local-gemini-root-for-origin-admission");
}

function localAuthority<Id extends VoiceProviderId>(
  provider: Id,
): BrowserProviderFundingAuthority<Id> {
  const authority = authorizeLocalDeploymentBrowserFunding(provider);
  if (!authority) throw new Error(`expected ${provider} local authority`);
  return authority as BrowserProviderFundingAuthority<Id>;
}

afterEach(() => vi.unstubAllEnvs());

describe("browser voice session funding/origin admission", () => {
  it.each([
    ["openai", "http://localhost:3000"],
    ["xai", "http://127.0.0.1:3000"],
    ["gemini", "http://[::1]:3000"],
  ] as const)(
    "admits %s on strict plain-HTTP loopback only with its issued local capability",
    (provider, origin) => {
      enableLocalFunding();
      expect(() => assertBrowserVoiceSessionAdmission({
        provider,
        origin,
        fundingAuthority: localAuthority(provider),
      })).not.toThrow();
    },
  );

  it.each([
    ["openai", TENANT_OPENAI_ROOT],
    ["xai", TENANT_XAI_ROOT],
  ] as const)(
    "admits %s tenant BYOK on canonical non-loopback HTTPS",
    (provider, apiKey) => {
      vi.stubEnv("NODE_ENV", "production");
      expect(() => assertBrowserVoiceSessionAdmission({
        provider,
        origin: "https://voice.example.test",
        fundingAuthority: {
          source: "tenant_byok",
          provider,
          apiKey,
        },
      })).not.toThrow();
    },
  );

  it("rejects tenant BYOK on loopback without reflecting its root", () => {
    const authority = {
      source: "tenant_byok" as const,
      provider: "openai" as const,
      apiKey: TENANT_OPENAI_ROOT,
    };
    let message = "";
    try {
      assertBrowserVoiceSessionAdmission({
        provider: "openai",
        origin: "http://localhost:3000",
        fundingAuthority: authority,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/canonical non-loopback HTTPS/);
    expect(message).not.toContain(TENANT_OPENAI_ROOT);
  });

  it.each([
    "https://localhost",
    "https://localhost.",
    "https://agent.localhost",
    "https://127.0.0.2",
    "https://127.255.255.255",
    "https://[::1]",
    "https://[::ffff:7f00:1]",
    "https://[::ffff:7fff:ffff]",
    "https://[::7f00:1]",
  ])(
    "rejects tenant BYOK on every loopback spelling: %s",
    (origin) => {
      let message = "";
      try {
        assertBrowserVoiceSessionAdmission({
          provider: "openai",
          origin,
          fundingAuthority: {
            source: "tenant_byok",
            provider: "openai",
            apiKey: TENANT_OPENAI_ROOT,
          },
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/canonical non-loopback HTTPS/);
      expect(message).not.toContain(TENANT_OPENAI_ROOT);
    },
  );

  it.each([
    "http://localhost.:3000",
    "http://agent.localhost:3000",
    "http://127.0.0.2:3000",
    "http://[::ffff:7f00:1]:3000",
  ])(
    "does not broaden local deployment authority to loopback aliases: %s",
    (origin) => {
      enableLocalFunding();
      expect(() => assertBrowserVoiceSessionAdmission({
        provider: "openai",
        origin,
        fundingAuthority: localAuthority("openai"),
      })).toThrow(/plain-HTTP loopback/);
    },
  );

  it("rejects an issued local capability after moving to a tunnel or production", () => {
    enableLocalFunding();
    const authority = localAuthority("xai");
    vi.stubEnv("PUBLIC_ORIGIN", "https://voice.example.test");
    expect(() => assertBrowserVoiceSessionAdmission({
      provider: "xai",
      origin: "https://voice.example.test",
      fundingAuthority: authority,
    })).toThrow(/plain-HTTP loopback/);

    vi.stubEnv("NODE_ENV", "production");
    expect(() => assertBrowserVoiceSessionAdmission({
      provider: "xai",
      origin: "http://localhost:3000",
      fundingAuthority: authority,
    })).toThrow(/plain-HTTP loopback/);
  });

  it("rejects forged, mismatched, and unsupported Gemini tenant authority", () => {
    expect(() => assertBrowserVoiceSessionAdmission({
      provider: "openai",
      origin: "http://localhost:3000",
      fundingAuthority: {
        source: "local_deployment_authorized",
        provider: "openai",
      },
    })).toThrow(/valid provider funding authority/);
    expect(() => assertBrowserVoiceSessionAdmission({
      provider: "openai",
      origin: "https://voice.example.test",
      fundingAuthority: {
        source: "tenant_byok",
        provider: "xai",
        apiKey: TENANT_XAI_ROOT,
      },
    })).toThrow(/valid provider funding authority/);
    expect(() => assertBrowserVoiceSessionAdmission({
      provider: "gemini",
      origin: "https://voice.example.test",
      fundingAuthority: {
        source: "tenant_byok",
        provider: "gemini",
        apiKey: "tenant-gemini-root-is-not-supported",
      },
    })).toThrow(/valid provider funding authority/);
  });
});
