import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  q: vi.fn(),
  qOne: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("../db", () => ({ q: mocks.q, qOne: mocks.qOne }));

import {
  allSessionCookieDeletions,
  DEVELOPMENT_SESSION_COOKIE_NAME,
  getSession,
  LEGACY_SESSION_COOKIE_NAME,
  presentedSessionBearers,
  revokePresentedSessions,
  SECURE_SESSION_COOKIE_NAME,
  sessionCookie,
  staleSessionCookieDeletions,
} from "../auth";

describe("cookie session security", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("PUBLIC_ORIGIN", "http://localhost:3000");
    mocks.q.mockResolvedValue([]);
  });

  afterEach(() => vi.unstubAllEnvs());

  function cookie(value: string | undefined): void {
    mocks.cookies.mockResolvedValue({
      get: () => value === undefined ? undefined : { value },
    });
  }

  function cookiesByName(values: Readonly<Record<string, string>>): void {
    mocks.cookies.mockResolvedValue({
      get: (name: string) => values[name] === undefined
        ? undefined
        : { name, value: values[name] },
    });
  }

  it("rejects malformed bearer cookies without touching the database", async () => {
    cookie("attacker-controlled-cookie");
    await expect(getSession()).resolves.toBeNull();
    expect(mocks.qOne).not.toHaveBeenCalled();
  });

  it("looks up only the token hash and fails closed on invalid session timestamps", async () => {
    const bearer = "ab".repeat(32);
    cookie(bearer);
    mocks.qOne.mockResolvedValueOnce({ email: "owner@example.test", last_used_at: "not-a-time" });
    await expect(getSession()).resolves.toBeNull();
    expect(mocks.qOne.mock.calls[0][1]).toEqual([
      createHash("sha256").update(bearer).digest("hex"),
    ]);
    expect(mocks.qOne.mock.calls[0][0]).toContain("token_hash_version = 1");
    expect(JSON.stringify(mocks.qOne.mock.calls)).not.toContain(bearer);
    expect(mocks.qOne).toHaveBeenCalledTimes(1);
  });

  it("rejects implausibly future last-use timestamps", async () => {
    cookie("cd".repeat(32));
    mocks.qOne.mockResolvedValueOnce({
      email: "owner@example.test",
      last_used_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    await expect(getSession()).resolves.toBeNull();
    expect(mocks.qOne).toHaveBeenCalledTimes(1);
  });

  it("binds a bearer to the organization captured when the session was minted", async () => {
    const orgId = "00000000-0000-4000-8000-000000000001";
    cookie("de".repeat(32));
    mocks.qOne
      .mockResolvedValueOnce({
        email: "owner@example.test",
        org_id: orgId,
        last_used_at: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        org_id: orgId,
        domain: null,
        phone_number: null,
        phone_verified_at: null,
      });
    const session = await getSession();
    expect(session).toMatchObject({
      email: "owner@example.test",
      orgId,
    });
    expect(session?.authSessionTokenHash).toBe(
      createHash("sha256").update("de".repeat(32)).digest("hex")
    );
    expect(JSON.stringify(session)).not.toContain("authSessionTokenHash");
    expect(Object.keys(session ?? {})).not.toContain("authSessionTokenHash");
    expect(mocks.qOne.mock.calls[1][1]).toEqual(["owner@example.test", orgId]);
  });

  it("marks the bearer cookie Secure in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_ORIGIN", "https://app.example.test");
    expect(sessionCookie("ef".repeat(32))).toMatchObject({
      name: SECURE_SESSION_COOKIE_NAME,
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
    });
  });

  it("uses a separate non-prefixed cookie only for HTTP local development", () => {
    expect(sessionCookie("ef".repeat(32))).toMatchObject({
      name: DEVELOPMENT_SESSION_COOKIE_NAME,
      secure: false,
      path: "/",
    });
  });

  it.each([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
  ])("permits an insecure development cookie only on loopback: %s", (origin) => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PUBLIC_ORIGIN", origin);
    expect(sessionCookie("ef".repeat(32))).toMatchObject({
      name: DEVELOPMENT_SESSION_COOKIE_NAME,
      secure: false,
    });
  });

  it.each([
    "http://dev.example.test",
    "http://192.0.2.10:3000",
    "http://0.0.0.0:3000",
  ])("rejects remote HTTP session origins outside production too: %s", (origin) => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PUBLIC_ORIGIN", origin);
    expect(() => sessionCookie("ef".repeat(32)))
      .toThrow("HTTP loopback is non-production-only");
  });

  it("never authenticates a valid legacy bearer after the host-cookie migration", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_ORIGIN", "https://app.example.test");
    cookiesByName({ [LEGACY_SESSION_COOKIE_NAME]: "ab".repeat(32) });

    await expect(getSession()).resolves.toBeNull();
    expect(mocks.qOne).not.toHaveBeenCalled();
  });

  it("deletes the __Host cookie with every browser-required attribute", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_ORIGIN", "https://app.example.test");

    const all = allSessionCookieDeletions();
    expect(all).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: SECURE_SESSION_COOKIE_NAME,
        value: "",
        secure: true,
        httpOnly: true,
        path: "/",
        maxAge: 0,
        expires: new Date(0),
      }),
      expect.objectContaining({
        name: LEGACY_SESSION_COOKIE_NAME,
        value: "",
        secure: true,
        path: "/",
        maxAge: 0,
      }),
    ]));
    expect(staleSessionCookieDeletions().map(({ name }) => name))
      .not.toContain(SECURE_SESSION_COOKIE_NAME);
  });

  it("preserves every duplicate bearer from the raw Cookie header for revocation", async () => {
    const host = "ab".repeat(32);
    const injectedDomain = "cd".repeat(32);
    const development = "ef".repeat(32);
    const raw = [
      `${LEGACY_SESSION_COOKIE_NAME}=${host}`,
      `${LEGACY_SESSION_COOKIE_NAME}=${injectedDomain}`,
      `${SECURE_SESSION_COOKIE_NAME}=${development}`,
      `${LEGACY_SESSION_COOKIE_NAME}=malformed`,
      `${LEGACY_SESSION_COOKIE_NAME}=${host}`,
    ].join("; ");

    expect(presentedSessionBearers(raw)).toEqual([host, injectedDomain, development]);
    await revokePresentedSessions(raw);
    expect(mocks.q).toHaveBeenCalledWith(
      expect.stringContaining("token = ANY($1::text[])"),
      [[host, injectedDomain, development].map((token) =>
        createHash("sha256").update(token).digest("hex"))],
    );
    expect(JSON.stringify(mocks.q.mock.calls)).not.toContain(host);
    expect(JSON.stringify(mocks.q.mock.calls)).not.toContain(injectedDomain);
  });

  it("fails closed on missing or insecure production public origins", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_ORIGIN", "");
    expect(() => sessionCookie("ef".repeat(32))).toThrow("PUBLIC_ORIGIN is required");
    vi.stubEnv("PUBLIC_ORIGIN", "http://app.example.test");
    expect(() => sessionCookie("ef".repeat(32))).toThrow("canonical HTTPS origin");
  });
});
