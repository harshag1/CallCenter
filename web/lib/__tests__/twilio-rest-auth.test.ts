import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkPhoneVerification, sendSms, startPhoneVerification } from "../sms";
import { acceptedTelephonyDeliveryReceipt, twilioRestAuthorization } from "../telephony";

const ACCOUNT_SID = `AC${"a".repeat(32)}`;
const API_KEY_SID = `SK${"b".repeat(32)}`;
const API_KEY_SECRET = "restricted-api-key-secret-123456789";
const ROOT_AUTH_TOKEN = "root-auth-token-must-never-fund-rest";

describe("Twilio outbound REST credential boundary", () => {
  beforeEach(() => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", ACCOUNT_SID);
    vi.stubEnv("TWILIO_AUTH_TOKEN", ROOT_AUTH_TOKEN);
    vi.stubEnv("TWILIO_PHONE_NUMBER", "+14155550100");
    vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", `VA${"c".repeat(32)}`);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("fails closed before fetch when only the account root token is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(() => twilioRestAuthorization()).toThrow(
      "TWILIO_API_KEY_TYPE must be restricted for Twilio REST access"
    );
    await expect(sendSms("+14155550101", "hello")).rejects.toThrow(
      "TWILIO_API_KEY_TYPE must be restricted for Twilio REST access"
    );
    await expect(startPhoneVerification("+14155550101")).rejects.toThrow(
      "TWILIO_API_KEY_TYPE must be restricted for Twilio REST access"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a Standard-key attestation even when an SK credential pair exists", () => {
    vi.stubEnv("TWILIO_API_KEY_TYPE", "standard");
    vi.stubEnv("TWILIO_API_KEY_ACCOUNT_SID", ACCOUNT_SID);
    vi.stubEnv("TWILIO_API_KEY_SID", API_KEY_SID);
    vi.stubEnv("TWILIO_API_KEY_SECRET", API_KEY_SECRET);

    expect(() => twilioRestAuthorization()).toThrow(
      "TWILIO_API_KEY_TYPE must be restricted for Twilio REST access"
    );
  });

  it("uses only the explicitly attested Restricted key for funded REST requests", async () => {
    vi.stubEnv("TWILIO_API_KEY_TYPE", "restricted");
    vi.stubEnv("TWILIO_API_KEY_ACCOUNT_SID", ACCOUNT_SID);
    vi.stubEnv("TWILIO_API_KEY_SID", API_KEY_SID);
    vi.stubEnv("TWILIO_API_KEY_SECRET", API_KEY_SECRET);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendSms("+14155550101", "hello");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`
    );
    expect(new Headers(init.headers).get("authorization")).toBe(
      `Basic ${Buffer.from(`${API_KEY_SID}:${API_KEY_SECRET}`).toString("base64")}`
    );
    expect(new Headers(init.headers).get("authorization")).not.toContain(ACCOUNT_SID);
    expect(new Headers(init.headers).get("authorization")).not.toContain(ROOT_AUTH_TOKEN);
  });

  it("bounds both Twilio Verify requests and rejects redirects", async () => {
    vi.stubEnv("TWILIO_API_KEY_TYPE", "restricted");
    vi.stubEnv("TWILIO_API_KEY_ACCOUNT_SID", ACCOUNT_SID);
    vi.stubEnv("TWILIO_API_KEY_SID", API_KEY_SID);
    vi.stubEnv("TWILIO_API_KEY_SECRET", API_KEY_SECRET);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 201 }))
      .mockResolvedValueOnce(new Response('{"status":"approved"}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await startPhoneVerification("+14155550101");
    await expect(checkPhoneVerification("+14155550101", "483920")).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      expect(init.redirect).toBe("error");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.signal?.aborted).toBe(false);
    }
  });

  it("rejects a Restricted key attested to a different Twilio account before fetch", async () => {
    vi.stubEnv("TWILIO_API_KEY_TYPE", "restricted");
    vi.stubEnv("TWILIO_API_KEY_ACCOUNT_SID", `AC${"d".repeat(32)}`);
    vi.stubEnv("TWILIO_API_KEY_SID", API_KEY_SID);
    vi.stubEnv("TWILIO_API_KEY_SECRET", API_KEY_SECRET);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendSms("+14155550101", "hello")).rejects.toThrow(
      "TWILIO_API_KEY_ACCOUNT_SID must exactly match TWILIO_ACCOUNT_SID"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps internal delivery receipt HMACs on a domain-specific secret", () => {
    vi.stubEnv("TELEPHONY_RECEIPT_SECRET", ROOT_AUTH_TOKEN);
    expect(() => acceptedTelephonyDeliveryReceipt({
      callId: "00000000-0000-4000-8000-000000000001",
      providerCallSid: `CA${"e".repeat(32)}`,
      providerAccountSid: ACCOUNT_SID,
      recipient: "+14155550101",
    })).toThrow("TELEPHONY_RECEIPT_SECRET must be domain-specific");

    vi.stubEnv("TELEPHONY_RECEIPT_SECRET", "domain-specific-receipt-secret-123456789");
    expect(acceptedTelephonyDeliveryReceipt({
      callId: "00000000-0000-4000-8000-000000000001",
      providerCallSid: `CA${"e".repeat(32)}`,
      providerAccountSid: ACCOUNT_SID,
      recipient: "+14155550101",
    })).toMatchObject({
      status: "accepted",
      account_binding_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      recipient_binding_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
});
