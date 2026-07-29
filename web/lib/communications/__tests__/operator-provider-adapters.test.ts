import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEmailCostQuote,
  createSmsCostQuote,
} from "../../operator-pricing";
import { createOperatorCommunicationDispatchers } from "../operator-provider-adapters";

const APPROVAL_ID = "00000000-0000-4000-8000-000000000001";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000002";
const ACCOUNT_SID = `AC${"a".repeat(32)}`;
const API_KEY_SID = `SK${"b".repeat(32)}`;
const MESSAGE_SID = `SM${"c".repeat(32)}`;
const RECEIPT_SECRET = "operator-communication-receipt-secret-123456789";

function commonEnvironment(): void {
  vi.stubEnv("TELEPHONY_RECEIPT_SECRET", RECEIPT_SECRET);
  vi.stubEnv("HACC_OPERATOR_EMAIL_SEND_CEILING_USD", "0.001995");
  vi.stubEnv("HACC_OPERATOR_SMS_SEGMENT_CEILING_USD", "0.009995");
  vi.stubEnv("HACC_OPERATOR_QUOTE_SAFETY_MARGIN_USD", "0.000005");
  vi.stubEnv("HACC_OPERATOR_QUOTE_TTL_SECONDS", "86400");
  vi.stubEnv("HACC_OPERATOR_QUOTE_MAX_RESERVATION_USD", "100");
  vi.stubEnv("RESEND_API_KEY", "synthetic-resend-credential-material");
  vi.stubEnv("EMAIL_FROM", "Operator <operator@example.test>");
  vi.stubEnv("TWILIO_ACCOUNT_SID", ACCOUNT_SID);
  vi.stubEnv("TWILIO_API_KEY_TYPE", "restricted");
  vi.stubEnv("TWILIO_API_KEY_ACCOUNT_SID", ACCOUNT_SID);
  vi.stubEnv("TWILIO_API_KEY_SID", API_KEY_SID);
  vi.stubEnv("TWILIO_API_KEY_SECRET", "restricted-key-secret-123456789");
  vi.stubEnv("TWILIO_PHONE_NUMBER", "+14155550100");
}

describe("operator communication provider adapters", () => {
  const sendEmail = vi.fn();
  const sendSms = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    commonEnvironment();
    sendEmail.mockResolvedValue({ providerMessageId: "resend-message-opaque" });
    sendSms.mockResolvedValue({
      providerMessageId: MESSAGE_SID,
      providerStatus: "queued",
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("routes Resend through v1 quote, authority, and receipt bindings", async () => {
    const dispatchers = createOperatorCommunicationDispatchers({
      sendEmail,
      sendSms,
    });
    const expectedQuote = createEmailCostQuote({
      recipient: "member@example.test",
    });

    const receipt = await dispatchers.email({
      to: "member@example.test",
      subject: "Renewal",
      message: "Your renewal is ready.",
      brand: "Membership",
      context: {
        approvalId: APPROVAL_ID,
        executionId: EXECUTION_ID,
        expectedQuote,
      },
    });

    expect(sendEmail).toHaveBeenCalledExactlyOnceWith({
      to: "member@example.test",
      subject: "Renewal",
      message: "Your renewal is ready.",
      brand: "Membership",
      idempotencyKey: EXECUTION_ID,
    });
    expect(receipt).toMatchObject({
      status: "accepted",
      adapterId: "hacc.resend.operator.v1",
      providerId: "resend",
      operation: "email.send",
      approvalId: APPROVAL_ID,
      executionId: EXECUTION_ID,
      idempotencyKey: EXECUTION_ID,
      providerMessageId: "resend-message-opaque",
      verifiedTerminal: false,
      retrySafe: false,
    });
    const encoded = JSON.stringify(receipt);
    expect(encoded).not.toContain("member@example.test");
    expect(encoded).not.toContain("Your renewal is ready.");
    expect(encoded).not.toContain("synthetic-resend-credential-material");
  });

  it("routes Twilio SMS through exclusive framework authority and keeps the SID", async () => {
    const dispatchers = createOperatorCommunicationDispatchers({
      sendEmail,
      sendSms,
    });
    const expectedQuote = createSmsCostQuote({
      destinationE164: "+14155550123",
      segmentCount: 1,
    });

    const receipt = await dispatchers.sms({
      to: "+14155550123",
      message: "Your renewal is ready.",
      segments: 1,
      context: {
        approvalId: APPROVAL_ID,
        executionId: EXECUTION_ID,
        expectedQuote,
      },
    });

    expect(sendSms).toHaveBeenCalledExactlyOnceWith(
      "+14155550123",
      "Your renewal is ready."
    );
    expect(receipt).toMatchObject({
      status: "accepted",
      adapterId: "hacc.twilio-sms.operator.v1",
      providerId: "twilio",
      operation: "sms.send",
      providerMessageId: MESSAGE_SID,
      executionId: EXECUTION_ID,
      idempotencyKey: EXECUTION_ID,
    });
    expect(JSON.stringify(receipt)).not.toContain("+14155550123");
  });

  it("fails closed before provider I/O when approved pricing authority drifts", async () => {
    const dispatchers = createOperatorCommunicationDispatchers({
      sendEmail,
      sendSms,
    });
    const wrongQuote = createSmsCostQuote({
      destinationE164: "+14155550999",
      segmentCount: 1,
    });

    await expect(dispatchers.sms({
      to: "+14155550123",
      message: "Your renewal is ready.",
      segments: 1,
      context: {
        approvalId: APPROVAL_ID,
        executionId: EXECUTION_ID,
        expectedQuote: wrongQuote,
      },
    })).rejects.toThrow("funded communication authority was denied");

    expect(sendSms).not.toHaveBeenCalled();
  });

  it("classifies a provider throw as indeterminate and never exposes the error", async () => {
    sendEmail.mockRejectedValueOnce(
      new Error("secret provider body member@example.test")
    );
    const dispatchers = createOperatorCommunicationDispatchers({
      sendEmail,
      sendSms,
    });

    const receipt = await dispatchers.email({
      to: "member@example.test",
      subject: "Renewal",
      message: "Your renewal is ready.",
      brand: null,
      context: {
        approvalId: APPROVAL_ID,
        executionId: EXECUTION_ID,
        expectedQuote: createEmailCostQuote({
          recipient: "member@example.test",
        }),
      },
    });

    expect(receipt).toMatchObject({
      status: "indeterminate",
      code: "provider_outcome_unknown",
      retrySafe: false,
    });
    expect(JSON.stringify(receipt)).not.toContain("secret provider body");
  });
});
