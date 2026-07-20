import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildVoiceRuntimeSnapshotForAdmission: vi.fn(),
  previewAvailablePhoneNumber: vi.fn(),
  proposeOperatorAction: vi.fn(),
  qOne: vi.fn(),
}));

vi.mock("../db", () => ({ qOne: mocks.qOne }));
vi.mock("../voice", () => ({
  buildVoiceRuntimeSnapshotForAdmission: mocks.buildVoiceRuntimeSnapshotForAdmission,
}));
vi.mock("../telephony", () => ({
  previewAvailablePhoneNumber: mocks.previewAvailablePhoneNumber,
}));
vi.mock("../agent/tools/operator-capability-policy", () => ({
  OperatorActionDeniedError: class OperatorActionDeniedError extends Error {
    readonly code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
  proposeOperatorAction: mocks.proposeOperatorAction,
}));

import { sendEmailTool, sendSmsTool } from "../agent/tools/comms";
import { placeCall, provisionPhoneNumber } from "../agent/tools/telephony";
import type { ToolCtx } from "../agent/types";
import { parseOperatorCostQuote } from "../operator-pricing";

const ctx: ToolCtx = Object.freeze({
  orgId: "00000000-0000-4000-8000-000000000001",
  email: "operator@example.test",
  agentId: null,
  origin: "https://operator.example.test",
  threadId: "00000000-0000-4000-8000-000000000002",
});

describe("funded communication pricing integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("HACC_OPERATOR_EMAIL_SEND_CEILING_USD", "0.002500");
    vi.stubEnv("HACC_OPERATOR_SMS_SEGMENT_CEILING_USD", "0.012345");
    vi.stubEnv("HACC_OPERATOR_VOICE_MINUTE_CEILING_USD", "0.125");
    vi.stubEnv("HACC_OPERATOR_NUMBER_MONTHLY_CEILING_USD", "2.50");
    vi.stubEnv("HACC_OPERATOR_CALL_MAX_DURATION_SECONDS", "900");
    vi.stubEnv("HACC_OPERATOR_QUOTE_SAFETY_MARGIN_USD", "0.000010");
    vi.stubEnv("HACC_OPERATOR_QUOTE_TTL_SECONDS", "300");
    vi.stubEnv("HACC_OPERATOR_QUOTE_MAX_RESERVATION_USD", "100");
    mocks.qOne.mockResolvedValue({ name: "Harsha's Amazing Call Center" });
    mocks.previewAvailablePhoneNumber.mockResolvedValue("+14155550199");
    mocks.buildVoiceRuntimeSnapshotForAdmission.mockResolvedValue({
      agentVersion: 3,
      digest: "a".repeat(64),
      snapshot: { schema_version: 1 },
    });
    mocks.proposeOperatorAction.mockImplementation(async (input: Record<string, unknown>) => ({
      ...input,
      proposalId: "00000000-0000-4000-8000-000000000003",
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("binds an email reservation to the normalized recipient and configured ceiling", async () => {
    const result = await sendEmailTool.execute({
      to: " PERSON@EXAMPLE.TEST ",
      subject: "Membership renewal",
      message: "Your renewal is ready.",
    }, ctx);

    expect(result.output).toEqual({
      status: "human_confirmation_required",
      proposal_id: "00000000-0000-4000-8000-000000000003",
    });
    expect(mocks.proposeOperatorAction).toHaveBeenCalledOnce();
    const input = mocks.proposeOperatorAction.mock.calls[0][0] as {
      argumentsValue: Record<string, unknown>;
      estimatedUnits: number;
      estimatedMicroUsd: number;
    };
    const quote = parseOperatorCostQuote(input.argumentsValue.cost_quote);
    expect(input.argumentsValue).toMatchObject({
      to: "person@example.test",
      subject: "Membership renewal",
      message: "Your renewal is ready.",
      brand: "Harsha's Amazing Call Center",
    });
    expect(quote).toMatchObject({
      unitKind: "email_send",
      units: 1,
      reservationMicroUsd: 2_510,
    });
    expect(input.estimatedUnits).toBe(quote.units);
    expect(input.estimatedMicroUsd).toBe(quote.reservationMicroUsd);
    expect(Object.isFrozen(quote)).toBe(true);
  });

  it("uses the exact GSM segment count in both SMS authority and quote", async () => {
    const message = "a".repeat(161);
    await sendSmsTool.execute({ to: "+14155550123", message }, ctx);

    const input = mocks.proposeOperatorAction.mock.calls[0][0] as {
      argumentsValue: Record<string, unknown>;
      estimatedUnits: number;
      estimatedMicroUsd: number;
    };
    const quote = parseOperatorCostQuote(input.argumentsValue.cost_quote);
    expect(input.argumentsValue).toMatchObject({
      to: "+14155550123",
      message,
      segments: 2,
    });
    expect(quote).toMatchObject({
      unitKind: "sms_segment",
      units: 2,
      reservationMicroUsd: 24_700,
    });
    expect(input.estimatedUnits).toBe(2);
    expect(input.estimatedMicroUsd).toBe(24_700);
  });

  it("fails closed before proposal issuance when pricing is not configured", async () => {
    vi.stubEnv("HACC_OPERATOR_SMS_SEGMENT_CEILING_USD", "");

    const result = await sendSmsTool.execute({
      to: "+14155550123",
      message: "hello",
    }, ctx);

    expect(result.output).toEqual({ error: "sms_proposal_unavailable" });
    expect(mocks.proposeOperatorAction).not.toHaveBeenCalled();
  });

  it("binds a call quote to the owned origin, destination, and enforced duration", async () => {
    mocks.qOne.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000004",
      phone_number: "+14155550101",
    });

    const result = await placeCall.execute({
      agent_id: "00000000-0000-4000-8000-000000000004",
      to_number: "+14155550123",
      reason: "Membership renewal",
      max_duration_seconds: 61,
    }, ctx);

    expect(result.output).toMatchObject({ status: "human_confirmation_required" });
    const input = mocks.proposeOperatorAction.mock.calls[0][0] as {
      argumentsValue: Record<string, unknown>;
      estimatedUnits: number;
      estimatedMicroUsd: number;
    };
    const quote = parseOperatorCostQuote(input.argumentsValue.cost_quote);
    expect(input.argumentsValue).toMatchObject({
      from_number: "+14155550101",
      to_number: "+14155550123",
      max_duration_seconds: 61,
    });
    expect(quote).toMatchObject({
      unitKind: "voice_minute",
      units: 2,
      reservationMicroUsd: 250_010,
    });
    expect(input.estimatedUnits).toBe(2);
    expect(input.estimatedMicroUsd).toBe(250_010);
  });

  it("previews and quotes the exact phone number later eligible for purchase", async () => {
    mocks.qOne.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000004",
      phone_number: null,
    });

    await provisionPhoneNumber.execute({
      agent_id: "00000000-0000-4000-8000-000000000004",
      area_code: "415",
    }, ctx);

    expect(mocks.previewAvailablePhoneNumber).toHaveBeenCalledExactlyOnceWith("415");
    const input = mocks.proposeOperatorAction.mock.calls[0][0] as {
      argumentsValue: Record<string, unknown>;
      estimatedMicroUsd: number;
    };
    const quote = parseOperatorCostQuote(input.argumentsValue.cost_quote);
    expect(input.argumentsValue).toMatchObject({
      candidate_number: "+14155550199",
      country_code: "US",
      number_type: "local",
    });
    expect(quote).toMatchObject({
      unitKind: "phone_number_month",
      reservationMicroUsd: 2_500_010,
    });
    expect(input.estimatedMicroUsd).toBe(2_500_010);
  });
});
