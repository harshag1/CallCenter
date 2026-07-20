import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decryptCredentialSecret,
  encryptCredentialSecret,
  encryptSecret,
  type CredentialSecretContext,
} from "../vault";

const ORG_A = "00000000-0000-4000-8000-000000000001";
const ORG_B = "00000000-0000-4000-8000-000000000002";
const SLOT_A = "00000000-0000-4000-8000-000000000011";
const SLOT_B = "00000000-0000-4000-8000-000000000012";
const SERVER_A = "00000000-0000-4000-8000-000000000021";
const VAULT_MASTER_KEY = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

const ENV_CONTEXT: CredentialSecretContext = {
  orgId: ORG_A,
  sinkKind: "env_var",
  sinkId: "OPENAI_API_KEY",
  slotId: SLOT_A,
};

describe("context-bound credential encryption", () => {
  beforeEach(() => vi.stubEnv("ENV_VAULT_MASTER_KEY", VAULT_MASTER_KEY));
  afterEach(() => vi.unstubAllEnvs());

  it("round-trips with randomized v2 envelopes", () => {
    const first = encryptCredentialSecret("sk-private", ENV_CONTEXT);
    const second = encryptCredentialSecret("sk-private", ENV_CONTEXT);
    expect(first).toMatch(/^hacc_v2:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]+$/);
    expect(second).not.toBe(first);
    expect(decryptCredentialSecret(first, ENV_CONTEXT)).toBe("sk-private");
    expect(decryptCredentialSecret(second, ENV_CONTEXT)).toBe("sk-private");
  });

  it.each([
    ["organization", { ...ENV_CONTEXT, orgId: ORG_B }],
    ["env name", { ...ENV_CONTEXT, sinkId: "OTHER_API_KEY" }],
    ["slot", { ...ENV_CONTEXT, slotId: SLOT_B }],
    ["sink kind/id", { ...ENV_CONTEXT, sinkKind: "mcp_server", sinkId: SERVER_A }],
  ] satisfies [string, CredentialSecretContext][]) (
    "rejects %s transplantation",
    (_label, wrongContext) => {
      const encrypted = encryptCredentialSecret("bound-secret", ENV_CONTEXT);
      expect(() => decryptCredentialSecret(encrypted, wrongContext)).toThrow(
        "credential ciphertext authentication failed"
      );
    }
  );

  it("rejects version, nonce, tag, ciphertext, and framing tampering", () => {
    const encrypted = encryptCredentialSecret("bound-secret", ENV_CONTEXT);
    const [version, iv, tag, ciphertext] = encrypted.split(":");
    const mutate = (value: string) => `${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`;
    for (const candidate of [
      `hacc_v1:${iv}:${tag}:${ciphertext}`,
      `${version}:${mutate(iv)}:${tag}:${ciphertext}`,
      `${version}:${iv}:${mutate(tag)}:${ciphertext}`,
      `${version}:${iv}:${tag}:${mutate(ciphertext)}`,
      `${encrypted}:extra`,
      `${version}:${iv}= :${tag}:${ciphertext}`,
    ]) {
      expect(() => decryptCredentialSecret(candidate, ENV_CONTEXT)).toThrow(
        "credential ciphertext authentication failed"
      );
    }
  });

  it("fails closed on legacy unbound ciphertext and malformed master keys", () => {
    const legacy = encryptSecret("legacy-secret");
    expect(() => decryptCredentialSecret(legacy, ENV_CONTEXT)).toThrow(
      "credential ciphertext authentication failed"
    );
    vi.stubEnv("ENV_VAULT_MASTER_KEY", "z".repeat(64));
    expect(() => encryptCredentialSecret("secret", ENV_CONTEXT)).toThrow(
      "ENV_VAULT_MASTER_KEY missing/invalid"
    );
  });
});
