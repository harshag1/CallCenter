// Author: Harsha Gundala
// auth.ts — OTP codes (HMAC at rest) and cookie sessions; org bootstrap on first login.

import { cookies } from "next/headers";
import { createHmac, randomBytes } from "node:crypto";
import { q, qOne } from "./db";

const SESSION_TTL_MS = 30 * 24 * 3600_000;
const IDLE_TTL_MS = 7 * 24 * 3600_000;
const PERSONAL_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "aol.com", "proton.me", "protonmail.com",
]);

export function generateCode(): string {
  return (randomBytes(4).readUInt32BE() % 1_000_000).toString().padStart(6, "0");
}

export function hmacCode(code: string): string {
  return createHmac("sha256", process.env.AUTH_CODE_HMAC_SECRET!).update(code).digest("hex");
}

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export type Session = { email: string; orgId: string; orgDomain: string | null };

export async function getSession(): Promise<Session | null> {
  const token = (await cookies()).get("session_token")?.value;
  if (!token) return null;
  const row = await qOne<{ email: string; last_used_at: string }>(
    `SELECT email, last_used_at FROM sessions_auth
     WHERE token = $1 AND is_active AND expires_at > now()`,
    [token]
  );
  if (!row) return null;
  if (Date.now() - new Date(row.last_used_at).getTime() > IDLE_TTL_MS) return null;
  if (Date.now() - new Date(row.last_used_at).getTime() > 60_000) {
    void q("UPDATE sessions_auth SET last_used_at = now() WHERE token = $1", [token]).catch(() => {});
  }
  const user = await qOne<{ org_id: string; domain: string | null }>(
    "SELECT u.org_id, o.domain FROM users u JOIN orgs o ON o.id = u.org_id WHERE u.email = $1",
    [row.email]
  );
  if (!user) return null;
  return { email: row.email, orgId: user.org_id, orgDomain: user.domain };
}

export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) throw Object.assign(new Error("unauthorized"), { status: 401 });
  return s;
}

/** Creates the user (and its org, keyed by email domain) if missing; returns a session token. */
export async function establishSession(email: string): Promise<string> {
  const domain = email.split("@")[1].toLowerCase();
  const orgDomain = PERSONAL_DOMAINS.has(domain) ? null : domain;

  let org = orgDomain
    ? await qOne<{ id: string }>("SELECT id FROM orgs WHERE domain = $1", [orgDomain])
    : await qOne<{ id: string }>(
        "SELECT o.id FROM orgs o JOIN users u ON u.org_id = o.id WHERE u.email = $1", [email]);
  if (!org) {
    org = await qOne<{ id: string }>(
      "INSERT INTO orgs (domain, name) VALUES ($1, $2) RETURNING id",
      [orgDomain, orgDomain ?? email]
    );
  }
  await q(
    "INSERT INTO users (email, org_id) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING",
    [email, org!.id]
  );
  const token = generateToken();
  await q(
    "INSERT INTO sessions_auth (token, email, expires_at) VALUES ($1, $2, $3)",
    [token, email, new Date(Date.now() + SESSION_TTL_MS)]
  );
  return token;
}

export const sessionCookie = (token: string) => ({
  name: "session_token",
  value: token,
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  maxAge: SESSION_TTL_MS / 1000,
  path: "/",
});
