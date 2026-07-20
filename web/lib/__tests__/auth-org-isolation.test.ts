import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  q: vi.fn(),
  qOne: vi.fn(),
  clientQuery: vi.fn(),
  connect: vi.fn(),
  release: vi.fn(),
  ensureSafeDatabaseRuntimeRole: vi.fn(),
}));
vi.mock("../db", () => ({
  q: mocks.q,
  qOne: mocks.qOne,
  ensureSafeDatabaseRuntimeRole: mocks.ensureSafeDatabaseRuntimeRole,
  getPool: () => ({ connect: mocks.connect }),
}));

import {
  anonymousAuthAbuseSourceHmac,
  establishSession,
  issueEmailVerificationCode,
  issuePhoneVerificationMarker,
  reservePhoneVerificationAttempt,
  verifyEmailCodeAndEstablishSession,
} from "../auth";

describe("authentication tenant isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.q.mockResolvedValue([]);
    mocks.ensureSafeDatabaseRuntimeRole.mockResolvedValue(undefined);
    mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO orgs")) {
        return { rows: [{ id: "00000000-0000-4000-8000-000000000001" }] };
      }
      if (sql.includes("INSERT INTO users")) {
        return { rows: [{ org_id: "00000000-0000-4000-8000-000000000001" }] };
      }
      return { rows: [] };
    });
  });

  it("does not authorize organization membership from a matching email domain", async () => {
    const bearer = await establishSession("New.User@Example.Test");

    const statements = mocks.clientQuery.mock.calls as [string, unknown[] | undefined][];
    expect(statements.find(([sql]) => sql.includes("JOIN users"))?.[1]).toEqual([
      "new.user@example.test",
    ]);
    expect(statements.find(([sql]) => sql.includes("INSERT INTO orgs"))?.[1]).toEqual([
      null,
      "new.user@example.test",
    ]);
    expect(statements.flat().join(" ")).not.toContain("ON CONFLICT (domain)");
    expect(statements.find(([sql]) => sql.includes("INSERT INTO users"))?.[1]).toEqual([
      "new.user@example.test",
      "00000000-0000-4000-8000-000000000001",
      null,
    ]);
    const sessionParams = statements.find(([sql]) => sql.includes("INSERT INTO sessions_auth"))?.[1];
    expect(statements.find(([sql]) => sql.includes("INSERT INTO sessions_auth"))?.[0])
      .toContain("token_hash_version");
    expect(sessionParams?.[0]).toBe(
      createHash("sha256").update(bearer).digest("hex")
    );
    expect(sessionParams).not.toContain(bearer);
    expect(mocks.ensureSafeDatabaseRuntimeRole).toHaveBeenCalledOnce();
    expect(mocks.ensureSafeDatabaseRuntimeRole.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.connect.mock.invocationCallOrder[0]);
    expect(statements.map(([sql]) => sql)).toEqual(expect.arrayContaining([
      "BEGIN ISOLATION LEVEL READ COMMITTED",
      "COMMIT",
    ]));
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("reuses only the organization already bound to the exact verified email", async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("JOIN users")) {
        return { rows: [{ id: "00000000-0000-4000-8000-000000000002" }] };
      }
      if (sql.includes("INSERT INTO users")) {
        return { rows: [{ org_id: "00000000-0000-4000-8000-000000000002" }] };
      }
      return { rows: [] };
    });
    await establishSession("owner@example.test", "+14155550123");
    const statements = mocks.clientQuery.mock.calls as [string, unknown[] | undefined][];
    expect(statements.some(([sql]) => sql.includes("INSERT INTO orgs"))).toBe(false);
    const userStatement = statements.find(([sql]) => sql.includes("INSERT INTO users"));
    expect(userStatement?.[1]?.[1]).toBe("00000000-0000-4000-8000-000000000002");
    expect(userStatement?.[0]).toContain("EXCLUDED.phone_number IS NULL");
    expect(userStatement?.[0]).toContain("users.phone_number = EXCLUDED.phone_number");
    expect(userStatement?.[0]).toContain("ELSE NULL");
  });

  it("takes a fresh statement snapshot after the issuer lock before consuming an OTP", async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("WITH candidate AS MATERIALIZED")) {
        return { rows: [{ matched: true }] };
      }
      if (sql.includes("JOIN users")) {
        return { rows: [{ id: "00000000-0000-4000-8000-000000000003" }] };
      }
      if (sql.includes("INSERT INTO users")) {
        return { rows: [{ org_id: "00000000-0000-4000-8000-000000000003" }] };
      }
      return { rows: [] };
    });

    const token = await verifyEmailCodeAndEstablishSession({
      email: "owner@example.test",
      codeHmac: "ab".repeat(32),
      phoneNumber: null,
    });

    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const statements = mocks.clientQuery.mock.calls as [string, unknown[] | undefined][];
    const lockIndex = statements.findIndex(([sql]) => sql.includes("pg_advisory_xact_lock"));
    const consumeIndex = statements.findIndex(([sql]) => sql.includes("WITH candidate AS MATERIALIZED"));
    expect(lockIndex).toBeGreaterThan(0);
    expect(consumeIndex).toBe(lockIndex + 1);
    const consumeSql = statements[consumeIndex][0];
    const candidateSql = consumeSql.slice(0, consumeSql.indexOf("), consumed AS"));
    expect(candidateSql).not.toContain("attempts < 5");
    expect(consumeSql).toContain("a.attempts < 5");
    expect(consumeSql).toContain("a.id <> c.id");
    expect(statements.at(-1)?.[0]).toBe("COMMIT");
  });

  it("rolls back if the verified identity becomes bound to a different org", async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO orgs")) {
        return { rows: [{ id: "00000000-0000-4000-8000-000000000004" }] };
      }
      if (sql.includes("INSERT INTO users")) {
        return { rows: [{ org_id: "00000000-0000-4000-8000-000000000005" }] };
      }
      return { rows: [] };
    });
    await expect(establishSession("raced@example.test"))
      .rejects.toThrow("organization binding changed");
    expect(mocks.clientQuery.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(mocks.clientQuery.mock.calls.some(([sql]) => sql.includes("INSERT INTO sessions_auth")))
      .toBe(false);
  });

  it("serializes phone attempts and caps the total across every recent challenge", async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("UPDATE phone_codes p")) return { rows: [{ id: "phone-attempt" }] };
      return { rows: [] };
    });

    await expect(reservePhoneVerificationAttempt("+14155550123")).resolves.toBe("phone-attempt");
    const statements = mocks.clientQuery.mock.calls as [string, unknown[] | undefined][];
    const lockIndex = statements.findIndex(([sql]) => sql.includes("pg_advisory_xact_lock"));
    const attemptIndex = statements.findIndex(([sql]) => sql.includes("UPDATE phone_codes p"));
    expect(attemptIndex).toBe(lockIndex + 1);
    expect(statements[attemptIndex][0]).toContain("sum(p.attempts)");
    expect(statements[attemptIndex][0]).toContain("b.attempts < 5");
  });

  it("takes a fresh statement snapshot after delivery-rate locks", async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("pg_try_advisory_xact_lock")) {
        return {
          rows: [{
            global_acquired: true,
            subject_acquired: true,
            source_acquired: true,
          }],
        };
      }
      if (sql.includes("INSERT INTO auth_codes")) return { rows: [{ id: "email-marker" }] };
      if (sql.includes("INSERT INTO phone_codes")) return { rows: [{ id: "phone-marker" }] };
      return { rows: [] };
    });

    await expect(issueEmailVerificationCode(
      "owner@example.test",
      "ab".repeat(32),
      "cd".repeat(32),
    )).resolves.toBe("email-marker");
    await expect(issuePhoneVerificationMarker("+14155550123"))
      .resolves.toBe("phone-marker");

    const statements = mocks.clientQuery.mock.calls as [string, unknown[] | undefined][];
    const emailLock = statements.findIndex(([sql]) => sql.includes("670041"));
    const emailInsert = statements.findIndex(([sql]) => sql.includes("INSERT INTO auth_codes"));
    const phoneLock = statements.findIndex(([sql]) => sql.includes("670043"));
    const phoneInsert = statements.findIndex(([sql]) => sql.includes("INSERT INTO phone_codes"));
    expect(emailInsert).toBe(emailLock + 1);
    expect(phoneInsert).toBe(phoneLock + 1);
    expect(statements[emailInsert][0]).not.toContain("pg_try_advisory_xact_lock");
    expect(statements[phoneInsert][0]).not.toContain("pg_try_advisory_xact_lock");
    expect(statements[emailInsert][0]).toContain("interval '1 minute') < 60");
    expect(statements[emailInsert][0]).toContain("request_source_hmac = $3");
    expect(statements[emailInsert][0]).toContain("interval '10 minutes') < 20");
    expect(statements[emailInsert][1]).toEqual([
      "owner@example.test",
      "ab".repeat(32),
      "cd".repeat(32),
    ]);
    expect(statements[phoneInsert][0]).toContain("interval '1 minute') < 30");
  });

  it("derives the anonymous abuse identity only from an explicitly trusted edge header", () => {
    vi.stubEnv("AUTH_CODE_HMAC_SECRET", "0123456789abcdef".repeat(4));
    vi.stubEnv("AUTH_TRUSTED_CLIENT_IP_HEADER", "x-real-ip");
    const trusted = new Request("https://app.example.test/api/auth/send-code", {
      headers: {
        "x-real-ip": "2001:0db8:0:0:0:0:0:1",
        "x-forwarded-for": "198.51.100.9",
      },
    });
    const canonicalAlias = new Request("https://app.example.test/api/auth/send-code", {
      headers: { "x-real-ip": "2001:db8::1" },
    });
    expect(anonymousAuthAbuseSourceHmac(trusted)).toMatch(/^[a-f0-9]{64}$/);
    expect(anonymousAuthAbuseSourceHmac(trusted))
      .toBe(anonymousAuthAbuseSourceHmac(canonicalAlias));

    vi.stubEnv("AUTH_TRUSTED_CLIENT_IP_HEADER", "");
    vi.stubEnv("VERCEL", "");
    expect(anonymousAuthAbuseSourceHmac(new Request(
      "https://app.example.test/api/auth/send-code",
      { headers: { "x-forwarded-for": "198.51.100.9" } },
    ))).toBeNull();
    vi.unstubAllEnvs();
  });
});
