import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteVoiceProviderCredential,
  isValidVoiceProviderCredential,
  loadVoiceProviderCredential,
  replaceVoiceProviderCredential,
  resolveBrowserVoiceFundingAuthority,
  VoiceProviderCredentialError,
  voiceProviderCredentialStatuses,
  type VoiceProviderCredentialDependencies,
} from "../voice-provider-credentials";

const ORG_A = "00000000-0000-4000-8000-0000000000a1";
const ORG_B = "00000000-0000-4000-8000-0000000000b2";
const SLOT = "00000000-0000-4000-8000-0000000000c3";
const ROOT = "tenant-provider-root-that-never-leaves-the-server";

afterEach(() => vi.unstubAllEnvs());

function dependencies(
  overrides: Partial<VoiceProviderCredentialDependencies> = {},
): VoiceProviderCredentialDependencies {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      void sql;
      void params;
      return [];
    }),
    queryOne: vi.fn(async (sql: string, params?: unknown[]) => {
      void sql;
      void params;
      return null;
    }),
    encrypt: vi.fn(() => "hacc_v2:encrypted"),
    decrypt: vi.fn(() => ROOT),
    randomUUID: vi.fn(() => SLOT),
    allowsLocalFunding: vi.fn(() => false),
    ...overrides,
  };
}

function row(provider: "openai" | "xai" = "openai") {
  return {
    provider,
    credential_encrypted: "hacc_v2:encrypted",
    encryption_slot_id: SLOT,
    updated_at: "2026-07-28T20:00:00.000Z",
  };
}

describe("tenant browser voice provider credential vault", () => {
  it("accepts bounded opaque roots and rejects whitespace, controls, short values, and unsupported providers", async () => {
    expect(isValidVoiceProviderCredential(ROOT)).toBe(true);
    expect(isValidVoiceProviderCredential(" short-root-value ")).toBe(false);
    expect(isValidVoiceProviderCredential("root-with-newline\n")).toBe(false);
    expect(isValidVoiceProviderCredential("short")).toBe(false);

    await expect(replaceVoiceProviderCredential({
      orgId: ORG_A,
      provider: "gemini" as "openai",
      credential: ROOT,
    }, dependencies())).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("encrypts with exact org/provider/generation context and never places plaintext in SQL", async () => {
    const queryOne = vi.fn(async (sql: string, params?: unknown[]) => {
      void sql;
      void params;
      return { updated_at: "2026-07-28T20:00:00.000Z" };
    });
    const encrypt = vi.fn(() => "hacc_v2:encrypted");
    const deps = dependencies({ queryOne, encrypt });

    await expect(replaceVoiceProviderCredential({
      orgId: ORG_A,
      provider: "openai",
      credential: ROOT,
    }, deps)).resolves.toEqual({
      provider: "openai",
      configured: true,
      updatedAt: "2026-07-28T20:00:00.000Z",
    });

    expect(encrypt).toHaveBeenCalledWith(ROOT, {
      orgId: ORG_A,
      sinkKind: "voice_provider",
      sinkId: "openai",
      slotId: SLOT,
    });
    const [sql, params] = queryOne.mock.calls[0]!;
    expect(sql).toContain("ON CONFLICT (org_id, provider) DO UPDATE");
    expect(params).toEqual([ORG_A, "openai", "hacc_v2:encrypted", SLOT]);
    expect(JSON.stringify(queryOne.mock.calls)).not.toContain(ROOT);
  });

  it("binds every read to the authenticated org and exact provider before decryption", async () => {
    const queryOne = vi.fn(async (sql: string, params?: unknown[]) => {
      void sql;
      void params;
      return row();
    });
    const decrypt = vi.fn(() => ROOT);
    const deps = dependencies({ queryOne, decrypt });

    await expect(loadVoiceProviderCredential({
      orgId: ORG_A,
      provider: "openai",
    }, deps)).resolves.toBe(ROOT);
    expect(queryOne.mock.calls[0]?.[1]).toEqual([ORG_A, "openai"]);
    expect(queryOne.mock.calls[0]?.[1]).not.toContain(ORG_B);
    expect(decrypt).toHaveBeenCalledWith("hacc_v2:encrypted", {
      orgId: ORG_A,
      sinkKind: "voice_provider",
      sinkId: "openai",
      slotId: SLOT,
    });
  });

  it("fails closed on provider substitution, malformed generations, and AEAD failure", async () => {
    await expect(loadVoiceProviderCredential({
      orgId: ORG_A,
      provider: "openai",
    }, dependencies({
      queryOne: vi.fn(async () => row("xai")),
    }))).rejects.toMatchObject({ code: "corrupt_record" });

    await expect(loadVoiceProviderCredential({
      orgId: ORG_A,
      provider: "openai",
    }, dependencies({
      queryOne: vi.fn(async () => ({
        ...row(),
        encryption_slot_id: "00000000-0000-5000-8000-0000000000d4",
      })),
    }))).rejects.toMatchObject({ code: "corrupt_record" });

    await expect(loadVoiceProviderCredential({
      orgId: ORG_A,
      provider: "openai",
    }, dependencies({
      queryOne: vi.fn(async () => row()),
      decrypt: vi.fn(() => {
        throw new Error(`vault failed near ${ROOT}`);
      }),
    }))).rejects.toEqual(expect.objectContaining({
      name: "VoiceProviderCredentialError",
      code: "corrupt_record",
    }));
  });

  it("uses local authority only on exact loopback and otherwise uses tenant BYOK", async () => {
    const tenant = dependencies({
      queryOne: vi.fn(async () => row("xai")),
      decrypt: vi.fn(() => ROOT),
      allowsLocalFunding: vi.fn(() => false),
    });
    await expect(resolveBrowserVoiceFundingAuthority({
      orgId: ORG_A,
      provider: "xai",
    }, tenant)).resolves.toEqual({
      source: "tenant_byok",
      provider: "xai",
      apiKey: ROOT,
    });

    await expect(resolveBrowserVoiceFundingAuthority({
      orgId: ORG_A,
      provider: "openai",
    }, dependencies())).resolves.toBeNull();

    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ALLOW_DEV_DEPLOYMENT_FUNDED_AI", "true");
    vi.stubEnv("PUBLIC_ORIGIN", "http://localhost:3000");
    vi.stubEnv("XAI_API_KEY", "local-xai-root-for-authority-test");
    vi.stubEnv("GEMINI_API_KEY", "local-gemini-root-for-authority-test");
    const tenantQuery = vi.fn(async () => row("xai"));
    await expect(resolveBrowserVoiceFundingAuthority({
      orgId: ORG_A,
      provider: "xai",
    }, dependencies({
      queryOne: tenantQuery,
      decrypt: vi.fn(() => ROOT),
      allowsLocalFunding: vi.fn(() => true),
    }))).resolves.toEqual({
      source: "local_deployment_authorized",
      provider: "xai",
    });
    expect(tenantQuery).not.toHaveBeenCalled();

    vi.stubEnv("XAI_API_KEY", "");
    const missingLocalKeyTenantQuery = vi.fn(async () => row("xai"));
    await expect(resolveBrowserVoiceFundingAuthority({
      orgId: ORG_A,
      provider: "xai",
    }, dependencies({
      queryOne: missingLocalKeyTenantQuery,
      decrypt: vi.fn(() => ROOT),
      allowsLocalFunding: vi.fn(() => true),
    }))).resolves.toBeNull();
    expect(missingLocalKeyTenantQuery).not.toHaveBeenCalled();

    await expect(resolveBrowserVoiceFundingAuthority({
      orgId: ORG_A,
      provider: "gemini",
    }, dependencies({
      allowsLocalFunding: vi.fn(() => true),
    }))).resolves.toEqual({
      source: "local_deployment_authorized",
      provider: "gemini",
    });

    vi.stubEnv("PUBLIC_ORIGIN", "https://voice.example.test");
    await expect(resolveBrowserVoiceFundingAuthority({
      orgId: ORG_A,
      provider: "gemini",
    }, dependencies({
      allowsLocalFunding: vi.fn(() => true),
    }))).resolves.toBeNull();
  });

  it("lists and deletes only rows selected by the authenticated organization", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      void params;
      return sql.startsWith("DELETE") ? [{ provider: "xai" }] : [row("openai")];
    });
    const deps = dependencies({ query });
    await expect(voiceProviderCredentialStatuses(ORG_A, deps)).resolves.toEqual([
      {
        provider: "xai",
        configured: false,
        updatedAt: null,
      },
      {
        provider: "openai",
        configured: true,
        updatedAt: "2026-07-28T20:00:00.000Z",
      },
    ]);
    expect(query.mock.calls[0]?.[1]?.[0]).toBe(ORG_A);

    await expect(deleteVoiceProviderCredential({
      orgId: ORG_B,
      provider: "xai",
    }, deps)).resolves.toBe(true);
    expect(query.mock.calls[1]?.[1]).toEqual([ORG_B, "xai"]);
  });

  it("normalizes database and encryption failures to credential-neutral errors", async () => {
    await expect(replaceVoiceProviderCredential({
      orgId: ORG_A,
      provider: "openai",
      credential: ROOT,
    }, dependencies({
      encrypt: vi.fn(() => {
        throw new Error(ROOT);
      }),
    }))).rejects.toEqual(expect.any(VoiceProviderCredentialError));
  });
});
