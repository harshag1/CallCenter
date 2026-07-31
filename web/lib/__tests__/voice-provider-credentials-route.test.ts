import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  allowsLocalDevelopmentFundedAi: vi.fn(),
  providerCatalog: vi.fn(),
  statuses: vi.fn(),
  replace: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/deployment-funded-ai", () => ({
  allowsLocalDevelopmentFundedAi: mocks.allowsLocalDevelopmentFundedAi,
}));
vi.mock("@/lib/realtime/registry", () => ({
  providerCatalog: mocks.providerCatalog,
}));
vi.mock("@/lib/voice-provider-credentials", async () => {
  const actual = await import("../voice-provider-credentials");
  return {
    ...actual,
    voiceProviderCredentialStatuses: mocks.statuses,
    replaceVoiceProviderCredential: mocks.replace,
    deleteVoiceProviderCredential: mocks.remove,
  };
});
vi.mock("@/lib/private-json-request", async () => import("../private-json-request"));
vi.mock("server-only", () => ({}));

import {
  DELETE,
  GET,
  POST,
} from "../../app/api/voice/providers/route";

const ORIGIN = "https://voice.example.test";
const ORG = "00000000-0000-4000-8000-0000000000a1";
const ROOT = "tenant-provider-root-that-must-never-be-reflected";

function request(method: "POST" | "DELETE", body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/api/voice/providers`, {
    method,
    headers: {
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("tenant browser voice credential route", () => {
  afterEach(() => vi.unstubAllEnvs());

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PUBLIC_ORIGIN", ORIGIN);
    mocks.getSession.mockResolvedValue({ orgId: ORG });
    mocks.allowsLocalDevelopmentFundedAi.mockReturnValue(false);
    mocks.providerCatalog.mockReturnValue([
      {
        id: "xai",
        label: "xAI",
        defaultModel: "grok-voice-think-fast-1.0",
        defaultVoice: "ara",
        env: ["XAI_API_KEY"],
        capabilities: {},
      },
      {
        id: "openai",
        label: "OpenAI",
        defaultModel: "gpt-realtime-2.1",
        defaultVoice: "marin",
        env: ["OPENAI_API_KEY"],
        capabilities: {},
      },
      {
        id: "gemini",
        label: "Gemini",
        defaultModel: "gemini-live",
        defaultVoice: "Kore",
        env: ["GEMINI_API_KEY"],
        capabilities: {},
      },
    ]);
    mocks.statuses.mockResolvedValue([
      { provider: "xai", configured: true, updatedAt: "2026-07-28T20:00:00.000Z" },
      { provider: "openai", configured: false, updatedAt: null },
    ]);
    mocks.replace.mockResolvedValue({
      provider: "openai",
      configured: true,
      updatedAt: "2026-07-28T20:00:00.000Z",
    });
    mocks.remove.mockResolvedValue(true);
  });

  it("requires authentication and never reads tenant status for an anonymous caller", async () => {
    mocks.getSession.mockResolvedValue(null);
    const response = await GET();
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.statuses).not.toHaveBeenCalled();
  });

  it("reports tenant BYOK without treating production deployment env as authority", async () => {
    vi.stubEnv("XAI_API_KEY", ROOT);
    const response = await GET();
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.providers).toEqual([
      expect.objectContaining({
        id: "xai",
        configured: true,
        credentialSource: "tenant_byok",
        credentialUpdatedAt: "2026-07-28T20:00:00.000Z",
        missingEnv: [],
      }),
      expect.objectContaining({
        id: "openai",
        configured: false,
        credentialSource: null,
        missingEnv: [],
      }),
      expect.objectContaining({
        id: "gemini",
        configured: false,
        credentialSource: null,
        missingEnv: [],
      }),
    ]);
    expect(mocks.statuses).toHaveBeenCalledWith(ORG);
    expect(JSON.stringify(payload)).not.toContain(ROOT);
  });

  it("reports local funding only when the loopback-authorized root is structurally valid", async () => {
    mocks.allowsLocalDevelopmentFundedAi.mockReturnValue(true);
    vi.stubEnv("GEMINI_API_KEY", "short");
    const invalid = await GET();
    const invalidProviders = (await invalid.json()).providers;
    expect(invalidProviders).toContainEqual(
      expect.objectContaining({
        id: "gemini",
        configured: false,
        credentialSource: null,
        missingEnv: ["GEMINI_API_KEY"],
      }),
    );
    expect(invalidProviders).toContainEqual(
      expect.objectContaining({
        id: "xai",
        configured: false,
        credentialSource: null,
        credentialUpdatedAt: null,
        missingEnv: ["XAI_API_KEY"],
      }),
    );

    vi.stubEnv("GEMINI_API_KEY", "local-gemini-root-valid-for-browser-funding");
    const valid = await GET();
    const payload = await valid.json();
    expect(payload.providers).toContainEqual(
      expect.objectContaining({
        id: "gemini",
        configured: true,
        credentialSource: "local_deployment",
        missingEnv: [],
      }),
    );
    expect(JSON.stringify(payload)).not.toContain(
      "local-gemini-root-valid-for-browser-funding",
    );

    vi.stubEnv("XAI_API_KEY", "local-xai-root-valid-for-browser-funding");
    const localWins = await GET();
    expect((await localWins.json()).providers).toContainEqual(
      expect.objectContaining({
        id: "xai",
        configured: true,
        credentialSource: "local_deployment",
      }),
    );
  });

  it.each([
    ["cross-origin", { origin: "https://attacker.example" }],
    ["same-site subdomain", { origin: "https://evil.example.test", "sec-fetch-site": "same-site" }],
    ["missing fetch metadata", { "sec-fetch-site": "" }],
    ["null origin", { origin: "null" }],
  ])("rejects %s before authentication or persistence", async (_label, headers) => {
    const response = await POST(request("POST", {
      provider: "openai",
      credential: ROOT,
    }, headers));
    expect(response.status).toBe(403);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("rejects unsupported providers, credential smuggling, and malformed content before persistence", async () => {
    const unsupported = await POST(request("POST", {
      provider: "gemini",
      credential: ROOT,
    }));
    expect(unsupported.status).toBe(400);

    const smuggled = await POST(request("POST", {
      provider: "openai",
      credential: ROOT,
      orgId: "00000000-0000-4000-8000-0000000000b2",
    }));
    expect(smuggled.status).toBe(400);

    const text = await POST(request("POST", {
      provider: "openai",
      credential: ROOT,
    }, { "content-type": "text/plain" }));
    expect(text.status).toBe(415);
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("stores under the authenticated org and returns only non-secret status", async () => {
    const response = await POST(request("POST", {
      provider: "openai",
      credential: ROOT,
    }));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      ok: true,
      provider: "openai",
      configured: true,
    });
    expect(mocks.replace).toHaveBeenCalledWith({
      orgId: ORG,
      provider: "openai",
      credential: ROOT,
    });
    expect(text).not.toContain(ROOT);
  });

  it("does not reflect provider plaintext or internal exceptions on storage failure", async () => {
    mocks.replace.mockRejectedValueOnce(new Error(`database echoed ${ROOT}`));
    const response = await POST(request("POST", {
      provider: "openai",
      credential: ROOT,
    }));
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toBe('{"error":"credential_store_unavailable"}');
    expect(text).not.toContain(ROOT);
  });

  it("deletes only the authenticated tenant/provider binding and is idempotent", async () => {
    const first = await DELETE(request("DELETE", { provider: "xai" }));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      ok: true,
      provider: "xai",
      configured: false,
      removed: true,
    });
    expect(mocks.remove).toHaveBeenCalledWith({
      orgId: ORG,
      provider: "xai",
    });

    mocks.remove.mockResolvedValueOnce(false);
    const second = await DELETE(request("DELETE", { provider: "xai" }));
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ removed: false });
  });
});
