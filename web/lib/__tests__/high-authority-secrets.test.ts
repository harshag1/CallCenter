import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deriveDomainSeparatedSecretKey,
  envVaultMasterKey,
  mcpGatewaySecret,
  validateMcpGatewaySecret,
  xaiSipSigningSecret,
} from "../high-authority-secrets";
import { actionCapabilitySecret } from "../flow-capability";
import { recordingConsentReceiptHmac } from "../recording-consent-authority";
import { encryptSecret } from "../vault";

const VAULT_KEY = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const MCP_KEY = "mcp_R4q7Xj2vN8sL5pC9wB3kD6fH1tY0uA7eM2zQ8rV5";
const XAI_SIGNING_KEY = "whsec_TnB3cVh5UzJmSzhqTDZwRDFhVzRnRTdt";
const DOMAIN_ENVIRONMENTS = [
  "ENV_VAULT_MASTER_KEY",
  "MCP_GATEWAY_SECRET",
  "AUTH_CODE_HMAC_SECRET",
  "CAMPAIGN_COMMITMENT_SECRET",
  "TELEPHONY_RECEIPT_SECRET",
  "XAI_SIP_SIGNING_SECRET",
  "XAI_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_API_KEY_SECRET",
  "RESEND_API_KEY",
] as const;

describe("high-authority secret convergence", () => {
  beforeEach(() => {
    for (const name of DOMAIN_ENVIRONMENTS) vi.stubEnv(name, "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("accepts independent production-shaped roots", () => {
    vi.stubEnv("ENV_VAULT_MASTER_KEY", VAULT_KEY);
    vi.stubEnv("MCP_GATEWAY_SECRET", MCP_KEY);
    vi.stubEnv("XAI_SIP_SIGNING_SECRET", XAI_SIGNING_KEY);

    expect(envVaultMasterKey()).toHaveLength(32);
    expect(mcpGatewaySecret()).toBe(MCP_KEY);
    expect(xaiSipSigningSecret()).toBe(XAI_SIGNING_KEY);
  });

  it.each([
    ["uniform zero hex", "0".repeat(64)],
    ["uniform nonzero hex", "a".repeat(64)],
    ["short-period hex", "01234567".repeat(8)],
  ])("rejects an unsafe vault %s", (_label, candidate) => {
    vi.stubEnv("ENV_VAULT_MASTER_KEY", candidate);
    expect(() => envVaultMasterKey()).toThrow(/unsafe placeholder/);
    expect(() => encryptSecret("credential")).toThrow(/unsafe placeholder/);
  });

  it.each([
    ["too short", "R4q7Xj2vN8sL5pC9"],
    ["control character", `mcp_R4q7Xj2vN8sL5pC9wB3kD6fH1tY0\nuA7e`],
    ["obvious placeholder", "change-me-before-production-please-000000"],
    ["uniform material", "z".repeat(48)],
    ["short-period material", "Ab3$xY7!".repeat(5)],
  ])("rejects MCP %s material at every converged consumer", (_label, candidate) => {
    vi.stubEnv("MCP_GATEWAY_SECRET", candidate);
    expect(() => mcpGatewaySecret()).toThrow();
    expect(() => actionCapabilitySecret()).toThrow();
    expect(() =>
      recordingConsentReceiptHmac("00000000-0000-4000-8000-000000000001")
    ).toThrow();
  });

  it("rejects exact reuse between vault, framework signing, and provider domains", () => {
    vi.stubEnv("ENV_VAULT_MASTER_KEY", VAULT_KEY);
    vi.stubEnv("MCP_GATEWAY_SECRET", VAULT_KEY);
    expect(() => envVaultMasterKey()).toThrow(/must not reuse secret material/);
    expect(() => mcpGatewaySecret()).toThrow(/must not reuse secret material/);

    vi.stubEnv("ENV_VAULT_MASTER_KEY", "");
    vi.stubEnv("MCP_GATEWAY_SECRET", MCP_KEY);
    vi.stubEnv("XAI_API_KEY", MCP_KEY);
    expect(() => mcpGatewaySecret()).toThrow(/must not reuse secret material/);

    vi.stubEnv("XAI_API_KEY", "");
    vi.stubEnv("XAI_SIP_SIGNING_SECRET", MCP_KEY);
    expect(() => xaiSipSigningSecret()).toThrow(/must not reuse secret material/);
  });

  it("rejects reuse hidden behind a different canonical encoding", () => {
    vi.stubEnv("ENV_VAULT_MASTER_KEY", VAULT_KEY);
    vi.stubEnv("MCP_GATEWAY_SECRET", Buffer.from(VAULT_KEY, "hex").toString("base64"));
    expect(() => envVaultMasterKey()).toThrow(/must not reuse secret material/);
  });

  it("derives pairwise-distinct subkeys for every MCP-root signing purpose", () => {
    const domains = [
      "harshas-amazing-call-center/capability/v2\n",
      "harshas-amazing-call-center/mcp-session/v1\n",
      "harshas-amazing-call-center:flow-action-lease:v1",
      "hacc/recording-consent-receipt/key/v1",
    ];
    const keys = domains.map((domain) =>
      deriveDomainSeparatedSecretKey(validateMcpGatewaySecret(MCP_KEY), domain).toString("hex")
    );
    expect(new Set(keys).size).toBe(domains.length);
  });
});
