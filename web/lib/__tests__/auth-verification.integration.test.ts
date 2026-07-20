import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.AUTH_SECURITY_INTEGRATION_DATABASE_URL;
const integration = describe.runIf(Boolean(databaseUrl));

integration("authentication verification database boundary", () => {
  const email = `otp-race-${randomUUID()}@example.test`;
  const successEmail = `otp-success-${randomUUID()}@example.test`;
  const lockExpiryEmail = `otp-lock-expiry-${randomUUID()}@example.test`;
  const phone = "+14155559999";
  const lockExpiryPhone = "+14155559731";
  const issuanceEmail = `otp-issuance-${randomUUID()}@example.test`;
  const rotatingSourcePrefix = `otp-source-${randomUUID()}`;
  const issuancePhone = "+14155559876";
  let modules: Awaited<ReturnType<typeof loadModules>>;

  async function loadModules() {
    if (databaseUrl) {
      process.env.DATABASE_URL = databaseUrl;
      process.env.DATABASE_SSL = "disable";
    }
    const [db, auth] = await Promise.all([import("../db"), import("../auth")]);
    return { db, auth };
  }

  beforeAll(async () => {
    modules = await loadModules();
  });

  afterAll(async () => {
    if (!modules) return;
    await modules.db.q("DELETE FROM sessions_auth WHERE email = ANY($1::text[])", [[email, successEmail, lockExpiryEmail]]).catch(() => {});
    await modules.db.q("DELETE FROM auth_codes WHERE email = ANY($1::text[])", [[email, successEmail, issuanceEmail, lockExpiryEmail]]).catch(() => {});
    await modules.db.q(
      "DELETE FROM auth_codes WHERE email LIKE $1",
      [`${rotatingSourcePrefix}-%@example.test`],
    ).catch(() => {});
    await modules.db.q("DELETE FROM phone_codes WHERE phone_number = ANY($1::text[])", [[phone, issuancePhone, lockExpiryPhone]]).catch(() => {});
    await modules.db.q("DELETE FROM users WHERE email = ANY($1::text[])", [[email, successEmail, lockExpiryEmail]]).catch(() => {});
    await modules.db.q("DELETE FROM orgs WHERE name = ANY($1::text[])", [[email, successEmail, lockExpiryEmail]]).catch(() => {});
    await modules.db.getPool().end();
  });

  it("takes a post-lock snapshot and never verifies an older OTP committed before a newer one", async () => {
    const olderHmac = "11".repeat(32);
    const newerHmac = "22".repeat(32);
    await modules.db.q(
      `INSERT INTO auth_codes (email, code_hmac, expires_at, created_at)
       VALUES ($1,$2,now() + interval '10 minutes',now() - interval '1 minute')`,
      [email, olderHmac]
    );

    const issuer = await modules.db.getPool().connect();
    try {
      await issuer.query("BEGIN");
      await issuer.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 172943))",
        [email]
      );
      await issuer.query(
        `INSERT INTO auth_codes (email, code_hmac, expires_at, created_at)
         VALUES ($1,$2,now() + interval '10 minutes',now())`,
        [email, newerHmac]
      );

      const verification = modules.auth.verifyEmailCodeAndEstablishSession({
        email,
        codeHmac: olderHmac,
      });
      let waiterObserved = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const waiting = await issuer.query<{ waiting: string }>(
          `SELECT count(*)::text AS waiting
           FROM pg_locks
           WHERE locktype = 'advisory' AND granted = false`
        );
        if (Number(waiting.rows[0]?.waiting ?? 0) > 0) {
          waiterObserved = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(waiterObserved).toBe(true);
      await issuer.query("COMMIT");

      await expect(verification).resolves.toBeNull();
      await expect(modules.db.q(
        "SELECT 1 FROM sessions_auth WHERE email = $1",
        [email]
      )).resolves.toHaveLength(0);
      await expect(modules.db.q<{ code_hmac: string; attempts: number }>(
        `SELECT code_hmac, attempts FROM auth_codes
         WHERE email = $1 ORDER BY created_at DESC, id DESC`,
        [email]
      )).resolves.toEqual([
        { code_hmac: newerHmac, attempts: 1 },
        { code_hmac: olderHmac, attempts: 0 },
      ]);
    } finally {
      await issuer.query("ROLLBACK").catch(() => {});
      issuer.release();
    }
  });

  it("caps provider verification attempts across all recent phone challenges", async () => {
    await modules.db.q(
      `INSERT INTO phone_codes
         (phone_number, code_hmac, expires_at, attempts, created_at)
       VALUES
         ($1,'twilio-verify',now() + interval '10 minutes',4,now() - interval '1 minute'),
         ($1,'twilio-verify',now() + interval '10 minutes',0,now())`,
      [phone]
    );
    await expect(modules.auth.reservePhoneVerificationAttempt(phone)).resolves.toEqual(expect.any(String));
    await expect(modules.auth.reservePhoneVerificationAttempt(phone)).resolves.toBeNull();
    await expect(modules.db.q<{ attempts: number }>(
      `SELECT attempts FROM phone_codes
       WHERE phone_number = $1 ORDER BY created_at DESC, id DESC`,
      [phone]
    )).resolves.toEqual([{ attempts: 1 }, { attempts: 4 }]);
  });

  it("rejects email and phone codes that expire while waiting on identity locks", async () => {
    const codeHmac = "55".repeat(32);
    await modules.db.q(
      `INSERT INTO auth_codes (email, code_hmac, expires_at)
       VALUES ($1,$2,now() + interval '10 minutes')`,
      [lockExpiryEmail, codeHmac]
    );
    await modules.db.q(
      `INSERT INTO phone_codes (phone_number, code_hmac, expires_at)
       VALUES ($1,'twilio-verify',now() + interval '10 minutes')`,
      [lockExpiryPhone]
    );

    const cases = [
      {
        identity: lockExpiryEmail,
        salt: 172943,
        start: () => modules.auth.verifyEmailCodeAndEstablishSession({
          email: lockExpiryEmail,
          codeHmac,
        }),
        expire: () => modules.db.q(
          `UPDATE auth_codes
           SET expires_at = clock_timestamp() + interval '50 milliseconds'
           WHERE email = $1`,
          [lockExpiryEmail]
        ),
      },
      {
        identity: lockExpiryPhone,
        salt: 493177,
        start: () => modules.auth.reservePhoneVerificationAttempt(lockExpiryPhone),
        expire: () => modules.db.q(
          `UPDATE phone_codes
           SET expires_at = clock_timestamp() + interval '50 milliseconds'
           WHERE phone_number = $1`,
          [lockExpiryPhone]
        ),
      },
    ] as const;

    for (const testCase of cases) {
      const locker = await modules.db.getPool().connect();
      try {
        await locker.query("BEGIN");
        await locker.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, $2))",
          [testCase.identity, testCase.salt]
        );
        const verification = testCase.start();
        let waiterObserved = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const waiting = await locker.query<{ waiting: string }>(
            `SELECT count(*)::text AS waiting
             FROM pg_locks
             WHERE locktype = 'advisory' AND granted = false`
          );
          if (Number(waiting.rows[0]?.waiting ?? 0) > 0) {
            waiterObserved = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(waiterObserved).toBe(true);
        await testCase.expire();
        await new Promise((resolve) => setTimeout(resolve, 100));
        await locker.query("COMMIT");
        await expect(verification).resolves.toBeNull();
      } finally {
        await locker.query("ROLLBACK").catch(() => {});
        locker.release();
      }
    }

    await expect(modules.db.q(
      "SELECT 1 FROM sessions_auth WHERE email = $1",
      [lockExpiryEmail]
    )).resolves.toHaveLength(0);
    await expect(modules.db.q<{ attempts: number }>(
      "SELECT attempts FROM phone_codes WHERE phone_number = $1",
      [lockExpiryPhone]
    )).resolves.toEqual([{ attempts: 0 }]);
  });

  it("atomically creates an org-bound session while persisting only the bearer hash", async () => {
    const codeHmac = "33".repeat(32);
    await modules.db.q(
      `INSERT INTO auth_codes (email, code_hmac, expires_at)
       VALUES ($1,$2,now() + interval '10 minutes')`,
      [successEmail, codeHmac]
    );
    const bearer = await modules.auth.verifyEmailCodeAndEstablishSession({
      email: successEmail,
      codeHmac,
    });
    expect(bearer).toMatch(/^[a-f0-9]{64}$/);
    const expectedHash = createHash("sha256").update(bearer!).digest("hex");
    await expect(modules.db.q<{
      token: string;
      token_hash_version: number;
      email: string;
      org_id: string;
    }>(
      `SELECT token, token_hash_version, email, org_id
       FROM sessions_auth WHERE email = $1`,
      [successEmail]
    )).resolves.toEqual([expect.objectContaining({
      token: expectedHash,
      token_hash_version: 1,
      email: successEmail,
      org_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })]);
    expect(expectedHash).not.toBe(bearer);
  });

  it("enforces delivery issuance caps from a post-lock database snapshot", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(modules.auth.issueEmailVerificationCode(
        issuanceEmail,
        "44".repeat(32),
        "55".repeat(32),
      )).resolves.toEqual(expect.any(String));
      await expect(modules.auth.issuePhoneVerificationMarker(issuancePhone))
        .resolves.toEqual(expect.any(String));
    }
    await expect(modules.auth.issueEmailVerificationCode(
      issuanceEmail,
      "44".repeat(32),
      "55".repeat(32),
    )).resolves.toBeNull();
    await expect(modules.auth.issuePhoneVerificationMarker(issuancePhone))
      .resolves.toBeNull();
    await expect(modules.db.q(
      "SELECT 1 FROM auth_codes WHERE email = $1",
      [issuanceEmail]
    )).resolves.toHaveLength(5);
    await expect(modules.db.q(
      "SELECT 1 FROM phone_codes WHERE phone_number = $1",
      [issuancePhone]
    )).resolves.toHaveLength(5);
  });

  it("caps one anonymous network source across rotating destination addresses", async () => {
    const source = "66".repeat(32);
    // Seed outside the one-minute global window so this assertion isolates the
    // ten-minute per-source budget and remains deterministic under parallel
    // integration workers.
    await modules.db.q(
      `INSERT INTO auth_codes
         (email, code_hmac, request_source_hmac, expires_at, created_at)
       SELECT
         $1 || '-' || series::text || '@example.test',
         $2,
         $3,
         now() + interval '5 minutes',
         now() - interval '5 minutes'
       FROM generate_series(0, 18) AS series`,
      [rotatingSourcePrefix, "77".repeat(32), source],
    );
    await expect(modules.auth.issueEmailVerificationCode(
      `${rotatingSourcePrefix}-19@example.test`,
      "77".repeat(32),
      source,
    )).resolves.toEqual(expect.any(String));
    await expect(modules.auth.issueEmailVerificationCode(
      `${rotatingSourcePrefix}-overflow@example.test`,
      "77".repeat(32),
      source,
    )).resolves.toBeNull();
    await expect(modules.auth.issueEmailVerificationCode(
      `${rotatingSourcePrefix}-independent@example.test`,
      "77".repeat(32),
      "88".repeat(32),
    )).resolves.toEqual(expect.any(String));
    await expect(modules.db.q(
      "SELECT 1 FROM auth_codes WHERE request_source_hmac = $1",
      [source],
    )).resolves.toHaveLength(20);
  });
});
