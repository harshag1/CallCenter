import { afterEach, describe, expect, it } from "vitest";
import { browserSpeechGuardrailConfigForCall } from "./browser-speech-guardrail-config.server";
import { parseBrowserSpeechGuardrailBootstrap } from "./browser-speech-guardrail-config";

const CALL_ID = "00000000-0000-4000-8000-000000000091";
const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000092";
const originalOpenAiKey = process.env.OPENAI_API_KEY;
const originalRequired = process.env.HACC_REQUIRE_BROWSER_SPEECH_GUARDRAILS;
const originalReceiptKey = process.env.HACC_OUTBOUND_SPEECH_ASR_RECEIPT_HMAC_KEY;
const originalCallBudget = process.env.HACC_OUTBOUND_SPEECH_ASR_MAX_MICRO_USD_PER_WEB_CALL;
const originalOrganizationBudget = process.env.HACC_OUTBOUND_SPEECH_ASR_MAX_MICRO_USD_PER_ORG_DAY;

function configureAuthority() {
  process.env.HACC_OUTBOUND_SPEECH_ASR_RECEIPT_HMAC_KEY =
    "browser-speech-guardrail-test-receipt-key";
  process.env.HACC_OUTBOUND_SPEECH_ASR_MAX_MICRO_USD_PER_WEB_CALL = "120000";
  process.env.HACC_OUTBOUND_SPEECH_ASR_MAX_MICRO_USD_PER_ORG_DAY = "600000";
}

afterEach(() => {
  if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiKey;
  if (originalRequired === undefined) delete process.env.HACC_REQUIRE_BROWSER_SPEECH_GUARDRAILS;
  else process.env.HACC_REQUIRE_BROWSER_SPEECH_GUARDRAILS = originalRequired;
  if (originalReceiptKey === undefined) delete process.env.HACC_OUTBOUND_SPEECH_ASR_RECEIPT_HMAC_KEY;
  else process.env.HACC_OUTBOUND_SPEECH_ASR_RECEIPT_HMAC_KEY = originalReceiptKey;
  if (originalCallBudget === undefined) delete process.env.HACC_OUTBOUND_SPEECH_ASR_MAX_MICRO_USD_PER_WEB_CALL;
  else process.env.HACC_OUTBOUND_SPEECH_ASR_MAX_MICRO_USD_PER_WEB_CALL = originalCallBudget;
  if (originalOrganizationBudget === undefined) delete process.env.HACC_OUTBOUND_SPEECH_ASR_MAX_MICRO_USD_PER_ORG_DAY;
  else process.env.HACC_OUTBOUND_SPEECH_ASR_MAX_MICRO_USD_PER_ORG_DAY = originalOrganizationBudget;
});

describe("server-authored browser speech guardrail configuration", () => {
  it("stays off unless the agent or deployment explicitly requires enforcement", () => {
    process.env.OPENAI_API_KEY = "test-asr-key";
    configureAuthority();
    expect(browserSpeechGuardrailConfigForCall({
      settings: {},
      provider: "xai",
      organizationId: ORGANIZATION_ID,
      callId: CALL_ID,
    })).toBeNull();
  });

  it("builds and re-parses a bounded exact-PCM policy without provider settings leakage", () => {
    process.env.OPENAI_API_KEY = "test-asr-key";
    configureAuthority();
    const bootstrap = browserSpeechGuardrailConfigForCall({
      settings: {
        speech_guardrail: {
          mode: "enforce",
          secrets: [{ value: "member access phrase", rule_id: "privacy.member_phrase" }],
          forbidden_terminal_claims: [{
            phrase: "your refund is complete",
            rule_id: "refund.requires_receipt",
          }],
        },
      },
      provider: "gemini",
      organizationId: ORGANIZATION_ID,
      callId: CALL_ID,
    });

    expect(parseBrowserSpeechGuardrailBootstrap(bootstrap)).toEqual(bootstrap);
    expect(bootstrap).toMatchObject({
      provider: "gemini",
      organizationId: ORGANIZATION_ID,
      callId: CALL_ID,
      policy: {
        evidencePolicy: "independent_asr_required",
        onEvidenceFailure: "suppress",
        terminalClaimsAuthorized: false,
        secrets: [{
          ruleId: "privacy.member_phrase",
          fingerprintSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }],
      },
    });
  });

  it("fails deployment-required calls when signed bounded ASR authority is unavailable", () => {
    delete process.env.HACC_OUTBOUND_SPEECH_ASR_RECEIPT_HMAC_KEY;
    process.env.HACC_OUTBOUND_SPEECH_ASR_MAX_MICRO_USD_PER_WEB_CALL = "120000";
    process.env.HACC_OUTBOUND_SPEECH_ASR_MAX_MICRO_USD_PER_ORG_DAY = "600000";
    process.env.HACC_REQUIRE_BROWSER_SPEECH_GUARDRAILS = "1";
    expect(() => browserSpeechGuardrailConfigForCall({
      settings: {},
      provider: "openai",
      organizationId: ORGANIZATION_ID,
      callId: CALL_ID,
    })).toThrow("RECEIPT_HMAC_KEY");
  });

  it("rejects a misspelled deployment-wide enforcement switch instead of disabling it", () => {
    configureAuthority();
    process.env.HACC_REQUIRE_BROWSER_SPEECH_GUARDRAILS = "true";
    expect(() => browserSpeechGuardrailConfigForCall({
      settings: {},
      provider: "openai",
      organizationId: ORGANIZATION_ID,
      callId: CALL_ID,
    })).toThrow("must be 0 or 1");
  });
});
