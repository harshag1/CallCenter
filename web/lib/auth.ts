// Author: Harsha Gundala
// auth.ts — OTP codes (HMAC at rest) and cookie sessions; org bootstrap on first login.

import { cookies } from "next/headers";
import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";
import { isIP } from "node:net";
import type { PoolClient } from "pg";
import { ensureSafeDatabaseRuntimeRole, getPool, q, qOne } from "./db";
import { PrivateRequestError, readStrictJsonObject } from "./private-json-request";

const SESSION_TTL_MS = 30 * 24 * 3600_000;
const IDLE_TTL_MS = 7 * 24 * 3600_000;
const AUTH_CODE_KEY_DOMAIN = "harshas-amazing-call-center/auth-code/v2\n";
const AUTH_ABUSE_SOURCE_KEY_DOMAIN = "harshas-amazing-call-center/auth-abuse-source/v1\n";
const AUTH_LOCAL_DEVELOPMENT_SOURCE_KEY_DOMAIN =
  "harshas-amazing-call-center/auth-local-development-source/v1\n";
const SESSION_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
export const SECURE_SESSION_COOKIE_NAME = "__Host-hacc_session";
export const DEVELOPMENT_SESSION_COOKIE_NAME = "hacc_dev_session";
export const LEGACY_SESSION_COOKIE_NAME = "session_token";
const SESSION_COOKIE_NAMES = Object.freeze([
  SECURE_SESSION_COOKIE_NAME,
  DEVELOPMENT_SESSION_COOKIE_NAME,
  LEGACY_SESSION_COOKIE_NAME,
] as const);
const AUTH_CODE_PATTERN = /^\d{6}$/;
const EMAIL_PATTERN = /^[^@\s\u0000-\u001f\u007f]+@[^@\s\u0000-\u001f\u007f]+\.[^@\s\u0000-\u001f\u007f]+$/;
const MAX_AUTH_REQUEST_BODY_BYTES = 8 * 1024;

export const AUTH_NO_STORE_HEADERS = Object.freeze({
  "Cache-Control": "no-store, max-age=0",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Pragma": "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});

export function generateCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

function authCodeHmacKey(): Buffer {
  const encoded = process.env.AUTH_CODE_HMAC_SECRET;
  if (!encoded || !/^[a-f0-9]{64}$/i.test(encoded)) {
    throw new Error("AUTH_CODE_HMAC_SECRET must be exactly 64 hexadecimal characters");
  }
  const key = Buffer.from(encoded, "hex");
  if (new Set(key).size < 8) {
    throw new Error("AUTH_CODE_HMAC_SECRET is an unsafe placeholder");
  }
  return key;
}

function isLoopbackSessionHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "[::1]"
    || normalized === "::1";
}

function secureSessionCookieRequired(): boolean {
  const configured = process.env.PUBLIC_ORIGIN?.trim();
  if (!configured) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("PUBLIC_ORIGIN is required for production authentication");
    }
    return false;
  }
  let origin: URL;
  try {
    origin = new URL(configured);
  } catch {
    throw new Error("PUBLIC_ORIGIN must be an absolute HTTP(S) origin");
  }
  const insecureDevelopmentLoopback = process.env.NODE_ENV !== "production"
    && origin.protocol === "http:"
    && isLoopbackSessionHostname(origin.hostname);
  if (
    (origin.protocol !== "https:" && !insecureDevelopmentLoopback)
    || origin.username
    || origin.password
    || origin.pathname !== "/"
    || origin.search
    || origin.hash
  ) {
    throw new Error(
      "PUBLIC_ORIGIN must be a canonical HTTPS origin (HTTP loopback is non-production-only)"
    );
  }
  return origin.protocol === "https:";
}

/** HTTPS sessions use a browser-enforced host-only cookie; HTTP is local-development only. */
export function sessionCookieName(): string {
  return secureSessionCookieRequired()
    ? SECURE_SESSION_COOKIE_NAME
    : DEVELOPMENT_SESSION_COOKIE_NAME;
}

/**
 * Preserve every recognized bearer from the raw Cookie header. Framework cookie
 * parsers collapse duplicate names, which would let a sibling-domain cookie
 * choose which session logout revokes.
 */
export function presentedSessionBearers(cookieHeader: string | null): readonly string[] {
  if (!cookieHeader) return Object.freeze([]);
  const acceptedNames = new Set<string>(SESSION_COOKIE_NAMES);
  const tokens = new Set<string>();
  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (acceptedNames.has(name) && SESSION_TOKEN_PATTERN.test(value)) {
      tokens.add(value);
    }
  }
  return Object.freeze([...tokens]);
}

/** Revoke every valid-shaped current, development, or legacy bearer presented. */
export async function revokePresentedSessions(cookieHeader: string | null): Promise<void> {
  const tokenHashes = presentedSessionBearers(cookieHeader).map(sessionTokenHash);
  if (tokenHashes.length === 0) return;
  await q(
    `UPDATE sessions_auth
     SET is_active = false
     WHERE token_hash_version = 1
       AND token = ANY($1::text[])`,
    [tokenHashes],
  );
}

export function normalizeEmailAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.length < 3 || normalized.length > 254 || !EMAIL_PATTERN.test(normalized)) return null;
  const separator = normalized.lastIndexOf("@");
  const local = normalized.slice(0, separator);
  const domain = normalized.slice(separator + 1);
  if (local.length > 64 || domain.length > 253 || domain.startsWith(".") || domain.endsWith(".")) return null;
  return normalized;
}

/** OTP digests are tenant-subject-bound so equal codes cannot be correlated across accounts. */
export function hmacCode(code: string, email: string): string {
  const normalizedEmail = normalizeEmailAddress(email);
  if (!normalizedEmail || !AUTH_CODE_PATTERN.test(code)) {
    throw new Error("invalid auth code HMAC input");
  }
  return createHmac("sha256", authCodeHmacKey())
    .update(AUTH_CODE_KEY_DOMAIN, "utf8")
    .update(normalizedEmail, "utf8")
    .update("\n", "utf8")
    .update(code, "utf8")
    .digest("hex");
}

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/** Session bearer bytes are never stored directly; a database read cannot replay the cookie. */
export function sessionTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export type Session = {
  email: string;
  orgId: string;
  orgDomain: string | null;
  phoneNumber: string | null;
  phoneVerifiedAt: string | null;
  /** Server-only digest used to revalidate this exact bearer after provider waits. */
  authSessionTokenHash: string;
};

const TRUSTED_CLIENT_IP_HEADERS = new Set([
  "cf-connecting-ip",
  "x-forwarded-for",
  "x-real-ip",
  "x-vercel-forwarded-for",
]);

function canonicalClientIp(value: string): string | null {
  const input = value.trim();
  if (isIP(input) === 4) return input;
  if (isIP(input) !== 6) return null;
  try {
    const hostname = new URL(`http://[${input}]/`).hostname;
    return hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1).toLowerCase()
      : null;
  } catch {
    return null;
  }
}

/**
 * Gives a plain `next dev` server one deliberately shared abuse-budget
 * identity without pretending a browser-controlled header is a client IP.
 *
 * This path is restricted to explicit stdout delivery in development, no
 * configured Resend credential, and a plaintext loopback PUBLIC_ORIGIN that
 * exactly matches the absolute Request.url authority. Request.url can itself
 * be derived from HTTP authority by a server adapter, so this is deliberately
 * a local quickstart gate, not socket-level client identity. Forwarding,
 * Origin, and fetch-metadata headers are not consulted. All local callers
 * share one durable budget instead of gaining a fresh budget by changing an
 * email address or a spoofable header.
 */
function localDevelopmentAuthAbuseAuthority(request: Request): string | null {
  if (
    process.env.NODE_ENV !== "development"
    || process.env.ALLOW_DEV_OTP_STDOUT !== "true"
    || Boolean(process.env.RESEND_API_KEY)
  ) {
    return null;
  }

  const configured = process.env.PUBLIC_ORIGIN?.trim();
  if (!configured) return null;

  try {
    const publicOrigin = new URL(configured);
    const requestUrl = new URL(request.url);
    if (
      publicOrigin.protocol !== "http:"
      || requestUrl.protocol !== "http:"
      || !isLoopbackSessionHostname(publicOrigin.hostname)
      || !isLoopbackSessionHostname(requestUrl.hostname)
      || publicOrigin.username
      || publicOrigin.password
      || publicOrigin.pathname !== "/"
      || publicOrigin.search
      || publicOrigin.hash
      || requestUrl.username
      || requestUrl.password
      || requestUrl.origin !== publicOrigin.origin
      || requestUrl.pathname !== "/api/auth/send-code"
      || requestUrl.search
      || requestUrl.hash
    ) {
      return null;
    }
    return publicOrigin.origin;
  } catch {
    return null;
  }
}

/**
 * Returns a non-reversible source binding only when the deployment explicitly
 * identifies a trusted proxy header. Vercel's platform-authenticated header is
 * the sole implicit policy; self-hosted deployments must opt into the header
 * their own edge overwrites. Blindly trusting arbitrary X-Forwarded-For would
 * let anonymous callers rotate this abuse boundary.
 */
export function anonymousAuthAbuseSourceHmac(request: Request): string | null {
  const localDevelopmentAuthority = localDevelopmentAuthAbuseAuthority(request);
  if (localDevelopmentAuthority) {
    return createHmac("sha256", authCodeHmacKey())
      .update(AUTH_LOCAL_DEVELOPMENT_SOURCE_KEY_DOMAIN, "utf8")
      .update(localDevelopmentAuthority, "utf8")
      .digest("hex");
  }

  const configured = process.env.AUTH_TRUSTED_CLIENT_IP_HEADER?.trim().toLowerCase();
  const headerName = configured || (process.env.VERCEL === "1" ? "x-vercel-forwarded-for" : "");
  if (!TRUSTED_CLIENT_IP_HEADERS.has(headerName)) return null;
  const raw = request.headers.get(headerName);
  if (!raw || raw.length > 512) return null;
  const values = raw.split(",").map((part) => part.trim());
  if (values.length === 0 || values.length > 8 || values.some((part) => !part)) return null;
  // A trusted forwarding edge appends hops; the left-most entry is the original
  // client. The policy is safe only when that edge overwrites/sanitizes input.
  const clientIp = canonicalClientIp(values[0]);
  if (!clientIp) return null;
  return createHmac("sha256", authCodeHmacKey())
    .update(AUTH_ABUSE_SOURCE_KEY_DOMAIN, "utf8")
    .update(clientIp, "utf8")
    .digest("hex");
}

export function normalizePhoneNumber(value: string): string | null {
  const raw = value.trim();
  if (/^\+\d{7,15}$/.test(raw)) return raw;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export class AuthRequestInputError extends Error {
  constructor(readonly status: 400 | 413 | 415) {
    super("invalid authentication request");
    this.name = "AuthRequestInputError";
  }
}

/** Strict, bounded JSON parsing keeps auth routes out of browser-simple CSRF and body-DoS paths. */
export async function readAuthJsonObject(request: Request): Promise<Record<string, unknown>> {
  try {
    return await readStrictJsonObject(request, MAX_AUTH_REQUEST_BODY_BYTES);
  } catch (error) {
    const status = error instanceof PrivateRequestError && error.status !== 403
      ? error.status
      : 400;
    throw new AuthRequestInputError(status);
  }
}

export function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => allowed.has(key));
}

export async function getSession(): Promise<Session | null> {
  // Never fall back to the legacy name: a hostile HTTPS sibling can set a
  // parent-Domain cookie with that name and swap the browser into its session.
  const token = (await cookies()).get(sessionCookieName())?.value;
  if (!token || !SESSION_TOKEN_PATTERN.test(token)) return null;
  const tokenHash = sessionTokenHash(token);
  const row = await qOne<{ email: string; org_id: string; last_used_at: string }>(
    `SELECT email, org_id, last_used_at FROM sessions_auth
     WHERE token = $1
       AND token_hash_version = 1
       AND is_active
       AND expires_at > now()`,
    [tokenHash]
  );
  if (!row) return null;
  const lastUsedAt = new Date(row.last_used_at).getTime();
  const normalizedEmail = normalizeEmailAddress(row.email);
  if (
    !Number.isFinite(lastUsedAt)
    || !normalizedEmail
    || normalizedEmail !== row.email
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.org_id)
  ) return null;
  const sessionAge = Date.now() - lastUsedAt;
  if (sessionAge < -5 * 60_000 || sessionAge > IDLE_TTL_MS) return null;
  if (sessionAge > 60_000) {
    void q("UPDATE sessions_auth SET last_used_at = now() WHERE token = $1", [tokenHash]).catch(() => {});
  }
  const user = await qOne<{ org_id: string; domain: string | null; phone_number: string | null; phone_verified_at: string | null }>(
    `SELECT u.org_id, o.domain, u.phone_number, u.phone_verified_at
     FROM users u JOIN orgs o ON o.id = u.org_id
     WHERE u.email = $1 AND u.org_id = $2`,
    [normalizedEmail, row.org_id]
  );
  if (!user) return null;
  const session = {
    email: normalizedEmail,
    orgId: user.org_id,
    orgDomain: user.domain,
    phoneNumber: user.phone_number,
    phoneVerifiedAt: user.phone_verified_at,
  } as Session;
  // Keep the revalidation digest available to server routes without making it
  // serializable through an accidental object spread or JSON response.
  Object.defineProperty(session, "authSessionTokenHash", {
    configurable: false,
    enumerable: false,
    value: tokenHash,
    writable: false,
  });
  return session;
}

export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) throw Object.assign(new Error("unauthorized"), { status: 401 });
  return s;
}

async function withAuthTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensureSafeDatabaseRuntimeRole();
  const client = await getPool().connect();
  try {
    // Explicitly pin READ COMMITTED: several auth invariants intentionally take
    // a fresh snapshot in the statement after an advisory lock.
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Reserves one email-delivery challenge under global and subject locks. Locking
 * is a separate statement so the rate-count statement observes commits made by
 * the previous lock holder under READ COMMITTED.
 */
export async function issueEmailVerificationCode(
  email: string,
  codeHmac: string,
  requestSourceHmac: string
): Promise<string | null> {
  const cleanEmail = normalizeEmailAddress(email);
  if (
    !cleanEmail
    || !/^[a-f0-9]{64}$/.test(codeHmac)
    || !/^[a-f0-9]{64}$/.test(requestSourceHmac)
  ) {
    throw new Error("invalid email verification issuance input");
  }
  return withAuthTransaction(async (client) => {
    const locks = (await client.query<{
      global_acquired: boolean;
      subject_acquired: boolean;
      source_acquired: boolean;
    }>(
      `SELECT pg_try_advisory_xact_lock(670041::bigint) AS global_acquired,
              pg_try_advisory_xact_lock(hashtextextended($1, 172943)) AS subject_acquired,
              pg_try_advisory_xact_lock(hashtextextended($2, 827551)) AS source_acquired`,
      [cleanEmail, requestSourceHmac]
    )).rows[0];
    if (!locks?.global_acquired || !locks.subject_acquired || !locks.source_acquired) return null;
    const issued = (await client.query<{ id: string }>(
      `WITH stale AS MATERIALIZED (
         SELECT id FROM auth_codes
         WHERE expires_at <= now()
         ORDER BY expires_at
         LIMIT 100
         FOR UPDATE SKIP LOCKED
       ), pruned AS (
         DELETE FROM auth_codes codes
         USING stale
         WHERE codes.id = stale.id
         RETURNING 1
       )
       INSERT INTO auth_codes (email, code_hmac, request_source_hmac, expires_at)
       SELECT $1, $2, $3, now() + interval '10 minutes'
       WHERE (SELECT count(*) FROM pruned) >= 0
         AND (SELECT count(*) FROM auth_codes
              WHERE email = $1 AND created_at > now() - interval '10 minutes') < 5
         AND (SELECT count(*) FROM auth_codes
              WHERE request_source_hmac = $3
                AND created_at > now() - interval '10 minutes') < 20
         AND (SELECT count(*) FROM auth_codes
              WHERE email = $1
                AND request_source_hmac = $3
                AND created_at > now() - interval '10 minutes') < 5
         AND (SELECT count(*) FROM auth_codes
              WHERE created_at > now() - interval '1 minute') < 60
       RETURNING id`,
      [cleanEmail, codeHmac, requestSourceHmac]
    )).rows[0];
    return issued?.id ?? null;
  });
}

/** Phone-delivery equivalent of issueEmailVerificationCode. */
export async function issuePhoneVerificationMarker(phoneNumber: string): Promise<string | null> {
  const cleanPhone = normalizePhoneNumber(phoneNumber);
  if (!cleanPhone) throw new Error("invalid phone verification issuance input");
  return withAuthTransaction(async (client) => {
    const locks = (await client.query<{ global_acquired: boolean; subject_acquired: boolean }>(
      `SELECT pg_try_advisory_xact_lock(670043::bigint) AS global_acquired,
              pg_try_advisory_xact_lock(hashtextextended($1, 493177)) AS subject_acquired`,
      [cleanPhone]
    )).rows[0];
    if (!locks?.global_acquired || !locks.subject_acquired) return null;
    const marker = (await client.query<{ id: string }>(
      `WITH stale AS MATERIALIZED (
         SELECT id FROM phone_codes
         WHERE expires_at <= now()
         ORDER BY expires_at
         LIMIT 100
         FOR UPDATE SKIP LOCKED
       ), pruned AS (
         DELETE FROM phone_codes codes
         USING stale
         WHERE codes.id = stale.id
         RETURNING 1
       )
       INSERT INTO phone_codes (phone_number, code_hmac, expires_at)
       SELECT $1, 'twilio-verify', now() + interval '10 minutes'
       WHERE (SELECT count(*) FROM pruned) >= 0
         AND (SELECT count(*) FROM phone_codes
              WHERE phone_number = $1 AND created_at > now() - interval '10 minutes') < 5
         AND (SELECT count(*) FROM phone_codes
              WHERE created_at > now() - interval '1 minute') < 30
       RETURNING id`,
      [cleanPhone]
    )).rows[0];
    return marker?.id ?? null;
  });
}

async function establishSessionInTransaction(
  client: PoolClient,
  cleanEmail: string,
  phoneNumber: string | null
): Promise<string> {
  let org = (await client.query<{ id: string }>(
    "SELECT o.id FROM orgs o JOIN users u ON u.org_id = o.id WHERE u.email = $1",
    [cleanEmail]
  )).rows[0];
  if (!org) {
    org = (await client.query<{ id: string }>(
      "INSERT INTO orgs (domain, name) VALUES ($1, $2) RETURNING id",
      [null, cleanEmail]
    )).rows[0];
  }
  if (!org) throw new Error("could not establish isolated organization");
  const boundUser = (await client.query<{ org_id: string | null }>(
    `INSERT INTO users (email, org_id, phone_number) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET
       phone_verified_at = CASE
         WHEN EXCLUDED.phone_number IS NULL OR users.phone_number = EXCLUDED.phone_number
           THEN users.phone_verified_at
         ELSE NULL
       END,
       phone_number = COALESCE(EXCLUDED.phone_number, users.phone_number)
     RETURNING org_id`,
    [cleanEmail, org.id, phoneNumber]
  )).rows[0];
  if (boundUser?.org_id !== org.id) {
    throw new Error("verified identity organization binding changed during session issuance");
  }
  const token = generateToken();
  await client.query(
    `INSERT INTO sessions_auth
       (token, token_hash_version, email, org_id, expires_at)
     VALUES ($1, 1, $2, $3, $4)`,
    [sessionTokenHash(token), cleanEmail, org.id, new Date(Date.now() + SESSION_TTL_MS)]
  );
  return token;
}

/**
 * Consumes the newest email OTP and establishes its session in one transaction.
 * The per-address lock is acquired in a separate statement so READ COMMITTED takes
 * a fresh snapshot after any concurrent issuer commits.
 */
export async function verifyEmailCodeAndEstablishSession(input: Readonly<{
  email: string;
  codeHmac: string;
  phoneNumber?: string | null;
}>): Promise<string | null> {
  secureSessionCookieRequired();
  const cleanEmail = normalizeEmailAddress(input.email);
  const cleanPhone = input.phoneNumber === undefined || input.phoneNumber === null
    ? null
    : normalizePhoneNumber(input.phoneNumber);
  if (
    !cleanEmail
    || !/^[a-f0-9]{64}$/.test(input.codeHmac)
    || (input.phoneNumber !== undefined && input.phoneNumber !== null && !cleanPhone)
  ) throw new Error("invalid email verification input");

  return withAuthTransaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 172943))",
      [cleanEmail]
    );
    const attempt = (await client.query<{ matched: boolean }>(
      `WITH candidate AS MATERIALIZED (
         SELECT a.id
         FROM auth_codes a
         WHERE a.email = $1
           AND a.used = false
           -- now() is frozen at transaction start and may be stale after the
           -- blocking identity lock. This statement begins after that lock.
           AND a.expires_at > statement_timestamp()
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT 1
         FOR UPDATE OF a
       ), consumed AS (
         UPDATE auth_codes a
         SET attempts = a.attempts + 1,
             used = CASE WHEN a.code_hmac = $2 THEN true ELSE a.used END
         FROM candidate c
         WHERE a.id = c.id AND a.attempts < 5
         RETURNING a.id, a.code_hmac = $2 AS matched
       ), invalidated AS (
         UPDATE auth_codes a
         SET used = true
         FROM consumed c
         WHERE c.matched
           AND a.email = $1
           AND a.id <> c.id
           AND a.used = false
         RETURNING 1
       )
       SELECT matched FROM consumed`,
      [cleanEmail, input.codeHmac]
    )).rows[0];
    if (!attempt?.matched) return null;
    return establishSessionInTransaction(client, cleanEmail, cleanPhone);
  });
}

/** Reserves one of at most five provider checks across every live challenge for a phone. */
export async function reservePhoneVerificationAttempt(phoneNumber: string): Promise<string | null> {
  const cleanPhone = normalizePhoneNumber(phoneNumber);
  if (!cleanPhone) throw new Error("invalid phone verification input");
  return withAuthTransaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 493177))",
      [cleanPhone]
    );
    const attempt = (await client.query<{ id: string }>(
      `WITH candidate AS MATERIALIZED (
         SELECT p.id
         FROM phone_codes p
         WHERE p.phone_number = $1
           AND p.code_hmac = 'twilio-verify'
           AND p.used = false
           AND p.expires_at > statement_timestamp()
         ORDER BY p.created_at DESC, p.id DESC
         LIMIT 1
         FOR UPDATE OF p
       ), budget AS MATERIALIZED (
         SELECT COALESCE(sum(p.attempts), 0) AS attempts
         FROM phone_codes p
         WHERE p.phone_number = $1
           AND p.created_at > statement_timestamp() - interval '10 minutes'
       )
       UPDATE phone_codes p
       SET attempts = p.attempts + 1
       FROM candidate c, budget b
       WHERE p.id = c.id
         AND p.attempts < 5
         AND b.attempts < 5
       RETURNING p.id`,
      [cleanPhone]
    )).rows[0];
    return attempt?.id ?? null;
  });
}

/**
 * Creates an isolated organization for a new verified identity. Never infer tenant
 * membership from a shared email domain; joining an existing org requires a
 * separate explicit invitation/domain-claim authorization flow.
 */
export async function establishSession(email: string, phoneNumber?: string | null): Promise<string> {
  secureSessionCookieRequired();
  const cleanEmail = normalizeEmailAddress(email);
  if (!cleanEmail) throw new Error("invalid session email");
  const cleanPhone = phoneNumber === undefined || phoneNumber === null
    ? null
    : normalizePhoneNumber(phoneNumber);
  if (phoneNumber !== undefined && phoneNumber !== null && !cleanPhone) {
    throw new Error("invalid session phone");
  }
  return withAuthTransaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 172943))",
      [cleanEmail]
    );
    return establishSessionInTransaction(client, cleanEmail, cleanPhone);
  });
}

export const sessionCookie = (token: string) => {
  if (!SESSION_TOKEN_PATTERN.test(token)) throw new Error("invalid session bearer");
  const secure = secureSessionCookieRequired();
  return {
    name: secure ? SECURE_SESSION_COOKIE_NAME : DEVELOPMENT_SESSION_COOKIE_NAME,
    value: token,
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    maxAge: SESSION_TTL_MS / 1000,
    path: "/",
  };
};

function sessionCookieDeletion(name: string, secure: boolean) {
  return {
    name,
    value: "",
    httpOnly: true,
    // The __Host- prefix requires Secure even when an HTTP development
    // response is merely attempting to remove an old HTTPS cookie.
    secure: name === SECURE_SESSION_COOKIE_NAME || secure,
    sameSite: "lax" as const,
    maxAge: 0,
    expires: new Date(0),
    path: "/",
  };
}

/** Clear every cookie name on logout; parent-Domain legacy cookies are ignored thereafter. */
export function allSessionCookieDeletions() {
  const secure = secureSessionCookieRequired();
  return SESSION_COOKIE_NAMES.map((name) => sessionCookieDeletion(name, secure));
}

/** Successful login clears obsolete names without deleting the newly issued active cookie. */
export function staleSessionCookieDeletions() {
  const secure = secureSessionCookieRequired();
  const activeName = secure ? SECURE_SESSION_COOKIE_NAME : DEVELOPMENT_SESSION_COOKIE_NAME;
  return SESSION_COOKIE_NAMES
    .filter((name) => name !== activeName)
    .map((name) => sessionCookieDeletion(name, secure));
}
