import { afterEach, describe, expect, it, vi } from "vitest";
import { sendLoginCode } from "../email";

const DELIVERY_ID = "00000000-0000-4000-8000-000000000001";

describe("login email development boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("never prints an OTP merely because the provider key is absent", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("ALLOW_DEV_OTP_STDOUT", "false");
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(sendLoginCode("owner@example.test", "483920", DELIVERY_ID)).rejects.toThrow(
      "RESEND_API_KEY is not configured"
    );
    expect(stdout).not.toHaveBeenCalled();
  });

  it("requires an explicit non-production opt-in before printing a development OTP", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("ALLOW_DEV_OTP_STDOUT", "true");
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(sendLoginCode("owner@example.test", "483920", DELIVERY_ID)).resolves.toBeUndefined();
    expect(stdout).toHaveBeenCalledWith("[explicit dev auth] owner@example.test: 483920");
  });

  it("ignores the development opt-in in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("ALLOW_DEV_OTP_STDOUT", "true");
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(sendLoginCode("owner@example.test", "483920", DELIVERY_ID)).rejects.toThrow(
      "RESEND_API_KEY is not configured"
    );
    expect(stdout).not.toHaveBeenCalled();
  });
});
