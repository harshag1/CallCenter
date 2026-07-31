import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  construct: vi.fn(),
  send: vi.fn(),
}));

vi.mock("resend", () => ({
  Resend: class Resend {
    readonly emails = { send: mocks.send };

    constructor(apiKey: string) {
      mocks.construct(apiKey);
    }
  },
}));

import { sendAgentEmail, sendLoginCode } from "../email";

const EXECUTION_ID = "00000000-0000-4000-8000-000000000001";
const LOGIN_DELIVERY_ID = "00000000-0000-4000-8000-000000000002";

describe("agent email provider idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("RESEND_API_KEY", "test_resend_key");
    vi.stubEnv("EMAIL_FROM", "Operator <operator@example.test>");
    mocks.send.mockResolvedValue({ data: { id: "provider-message" }, error: null });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("forwards the durable execution UUID as Resend's provider idempotency key", async () => {
    const result = await sendAgentEmail({
      to: "member@example.test",
      subject: "Renewal",
      message: "Your renewal is ready.",
      brand: "Membership Club",
      idempotencyKey: EXECUTION_ID,
    });

    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.send.mock.calls[0]?.[1]).toEqual({ idempotencyKey: EXECUTION_ID });
    expect(mocks.send.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      from: "Operator <operator@example.test>",
      to: "member@example.test",
      subject: "Renewal",
    }));
    expect(result).toEqual({ providerMessageId: "provider-message" });
  });

  it("rejects an accepted response without an opaque provider identity", async () => {
    mocks.send.mockResolvedValueOnce({ data: null, error: null });

    await expect(sendAgentEmail({
      to: "member@example.test",
      subject: "Renewal",
      message: "Your renewal is ready.",
      idempotencyKey: EXECUTION_ID,
    })).rejects.toThrow("omitted a valid message identity");
  });

  it("rejects a caller-selected non-UUID key before contacting Resend", async () => {
    await expect(sendAgentEmail({
      to: "member@example.test",
      subject: "Renewal",
      message: "Your renewal is ready.",
      idempotencyKey: "model-selected-key",
    })).rejects.toThrow("invalid email idempotency key");

    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("passes the same provider key on an exact caller retry", async () => {
    const input = {
      to: "member@example.test",
      subject: "Renewal",
      message: "Your renewal is ready.",
      idempotencyKey: EXECUTION_ID,
    } as const;

    await sendAgentEmail(input);
    await sendAgentEmail(input);

    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.send.mock.calls.map((call) => call[1])).toEqual([
      { idempotencyKey: EXECUTION_ID },
      { idempotencyKey: EXECUTION_ID },
    ]);
  });
});

describe("login email provider idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("RESEND_API_KEY", "test_resend_key");
    vi.stubEnv("EMAIL_FROM", "Auth <auth@example.test>");
    mocks.send.mockResolvedValue({ data: { id: "provider-message" }, error: null });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("reuses the durable auth-code UUID verbatim across an adversarial replay", async () => {
    await sendLoginCode("owner@example.test", "483920", LOGIN_DELIVERY_ID);
    await sendLoginCode("owner@example.test", "483920", LOGIN_DELIVERY_ID);

    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.send.mock.calls.map((call) => call[1])).toEqual([
      { idempotencyKey: LOGIN_DELIVERY_ID },
      { idempotencyKey: LOGIN_DELIVERY_ID },
    ]);
  });

  it("uses a different provider key for a different durable auth-code row", async () => {
    const nextDeliveryId = "00000000-0000-4000-8000-000000000003";

    await sendLoginCode("owner@example.test", "483920", LOGIN_DELIVERY_ID);
    await sendLoginCode("owner@example.test", "109284", nextDeliveryId);

    expect(mocks.send.mock.calls.map((call) => call[1])).toEqual([
      { idempotencyKey: LOGIN_DELIVERY_ID },
      { idempotencyKey: nextDeliveryId },
    ]);
  });

  it("rejects a caller-selected replay key before stdout or provider contact", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ALLOW_DEV_OTP_STDOUT", "true");
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(sendLoginCode(
      "owner@example.test",
      "483920",
      "attacker-selected-key"
    )).rejects.toThrow("invalid email idempotency key");

    expect(stdout).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
