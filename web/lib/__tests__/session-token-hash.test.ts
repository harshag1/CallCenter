import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hmacCode,
  normalizeEmailAddress,
  readAuthJsonObject,
  sessionTokenHash,
} from "../auth";

describe("session token storage", () => {
  it("stores a deterministic non-replayable hash rather than cookie bearer bytes", () => {
    const bearer = "a".repeat(64);
    const stored = sessionTokenHash(bearer);
    expect(stored).toMatch(/^[a-f0-9]{64}$/);
    expect(stored).not.toBe(bearer);
    expect(sessionTokenHash(bearer)).toBe(stored);
    expect(sessionTokenHash("b".repeat(64))).not.toBe(stored);
  });
});

describe("authentication input boundary", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("binds OTP HMACs to a normalized email and rejects placeholder keys", () => {
    vi.stubEnv("AUTH_CODE_HMAC_SECRET", "00112233445566778899aabbccddeefffedcba98765432100123456789abcdef");
    expect(hmacCode("483920", " Owner@Example.Test ")).toBe(
      hmacCode("483920", "owner@example.test")
    );
    expect(hmacCode("483920", "owner@example.test")).not.toBe(
      hmacCode("483920", "other@example.test")
    );
    vi.stubEnv("AUTH_CODE_HMAC_SECRET", "00".repeat(32));
    expect(() => hmacCode("483920", "owner@example.test")).toThrow("unsafe placeholder");
  });

  it("normalizes bounded emails and rejects control characters", () => {
    expect(normalizeEmailAddress(" Owner@Example.Test ")).toBe("owner@example.test");
    expect(normalizeEmailAddress(`owner\u0000@example.test`)).toBeNull();
    expect(normalizeEmailAddress(`${"a".repeat(65)}@example.test`)).toBeNull();
  });

  it("requires bounded application/json before parsing auth bodies", async () => {
    await expect(readAuthJsonObject(new Request("https://app.example.test/api/auth", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: '{"email":"owner@example.test"}',
    }))).rejects.toMatchObject({ status: 415 });
    await expect(readAuthJsonObject(new Request("https://app.example.test/api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(9 * 1024) }),
    }))).rejects.toMatchObject({ status: 413 });
  });
});
