import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  qOne: vi.fn(),
  signScope: vi.fn(),
  verifyScope: vi.fn(),
  verifyTwilioWebhook: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ qOne: mocks.qOne }));
vi.mock("@/lib/voice", () => ({
  signScope: mocks.signScope,
  verifyScope: mocks.verifyScope,
}));
vi.mock("@/lib/telephony", () => ({
  normalizeE164: (value: string | null) => (
    typeof value === "string" && /^\+[1-9]\d{7,14}$/.test(value) ? value : null
  ),
  requireBridgeWsUrl: () => "wss://bridge.example.test/twilio/media",
  twilioAccountSid: () => `AC${"a".repeat(32)}`,
  verifyTwilioWebhook: mocks.verifyTwilioWebhook,
}));
vi.mock("@/lib/http", () => ({
  isUuid: (value: string) => /^[0-9a-f-]{36}$/i.test(value),
}));
vi.mock("@/lib/log", () => ({
  log: () => ({ warn: mocks.warn }),
}));

import { POST } from "../../app/api/telephony/twiml/route";

const ACCOUNT_SID = `AC${"a".repeat(32)}`;
const CALL_SID = `CA${"b".repeat(32)}`;
const CALL_ID = "00000000-0000-4000-8000-000000000061";
const AGENT_ID = "00000000-0000-4000-8000-000000000062";
const ORG_ID = "00000000-0000-4000-8000-000000000063";
const TO = "+14155550101";
const FROM = "+14155550102";

function inboundRequest(): Request {
  return new Request("https://voice.example.test/api/telephony/twiml", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      AccountSid: ACCOUNT_SID,
      CallSid: CALL_SID,
      To: TO,
      From: FROM,
    }),
  });
}

describe("Twilio Media Stream custom-parameter budget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyTwilioWebhook.mockResolvedValue({
      canonicalUrl: "https://voice.example.test/api/telephony/twiml",
      query: new URLSearchParams(),
      form: new URLSearchParams({
        AccountSid: ACCOUNT_SID,
        CallSid: CALL_SID,
        To: TO,
        From: FROM,
      }),
      rawBody: "",
    });
    mocks.qOne.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM agents WHERE phone_number")) {
        return { id: AGENT_ID, org_id: ORG_ID, version: 1 };
      }
      if (sql.includes("INSERT INTO calls")) {
        return { id: CALL_ID, agent_id: AGENT_ID, org_id: ORG_ID, to_number: TO };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
  });

  it("accepts an exact 500-byte bridgeToken name-plus-value boundary", async () => {
    // The multibyte fixture proves this is a UTF-8 byte budget, not a JS
    // character-count budget: 244 * 2 + 1 = 489 value bytes, plus 11 name bytes.
    const boundaryToken = `${"é".repeat(244)}x`;
    expect(Buffer.byteLength("bridgeToken", "utf8") + Buffer.byteLength(boundaryToken, "utf8"))
      .toBe(500);
    mocks.signScope.mockReturnValue(boundaryToken);

    const response = await POST(inboundRequest());

    expect(response.status).toBe(200);
    const xml = await response.text();
    expect(xml).toContain(`<Parameter name="bridgeToken" value="${boundaryToken}"/>`);
    expect(xml.match(/<Parameter /g)).toHaveLength(2);
  });

  it("fails closed when capability evolution would exceed the 500-byte boundary", async () => {
    const oversizedToken = "é".repeat(245);
    expect(Buffer.byteLength("bridgeToken", "utf8") + Buffer.byteLength(oversizedToken, "utf8"))
      .toBe(501);
    mocks.signScope.mockReturnValue(oversizedToken);

    await expect(POST(inboundRequest())).rejects.toThrow(
      "bridge bootstrap capability exceeds Twilio's custom-parameter budget"
    );
  });
});
