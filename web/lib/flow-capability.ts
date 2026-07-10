// Short-lived, revision-scoped action leases for realtime tool calls.

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const DOMAIN = "harshas-amazing-call-center:flow-action-lease:v1";
const DEFAULT_TTL_SECONDS = 5 * 60;
export const MAX_FLOW_CAPABILITY_TTL_SECONDS = 60 * 60;

export type FlowCapabilityClaims = {
  typ: "flow-action-lease";
  v: 1;
  callId: string;
  agentId: string;
  orgId: string;
  runtimeDigest: string;
  capabilityEpoch: number;
  step: string;
  attempt: number;
  tool: string;
  nonce: string;
  iat: number;
  exp: number;
};

type CapabilitySubject = Omit<FlowCapabilityClaims, "typ" | "v" | "nonce" | "iat" | "exp">;

export type FlowCapabilityError = {
  error: string;
  code:
    | "invalid_capability"
    | "expired_capability"
    | "capability_scope_mismatch"
    | "capability_ttl_exceeded";
};

function signingKey(secret: string): Buffer {
  if (secret.length < 32) throw new Error("MCP_GATEWAY_SECRET must be at least 32 characters");
  return createHmac("sha256", secret).update(DOMAIN).digest();
}

function signature(body: string, secret: string): Buffer {
  return createHmac("sha256", signingKey(secret)).update(body).digest();
}

export function actionCapabilitySecret(): string {
  const secret = process.env.MCP_GATEWAY_SECRET;
  if (!secret) throw new Error("MCP_GATEWAY_SECRET is required for flow action leases");
  return secret;
}

export function signFlowCapability(
  subject: CapabilitySubject,
  options: { secret?: string; nowMs?: number; ttlSeconds?: number; nonce?: string } = {}
): { token: string; expiresAt: string; claims: FlowCapabilityClaims } {
  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_FLOW_CAPABILITY_TTL_SECONDS) {
    throw new Error(`flow action lease TTL must be between 1 and ${MAX_FLOW_CAPABILITY_TTL_SECONDS} seconds`);
  }
  const claims: FlowCapabilityClaims = {
    typ: "flow-action-lease",
    v: 1,
    ...subject,
    nonce: options.nonce ?? randomUUID(),
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
  };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = signature(body, options.secret ?? actionCapabilitySecret()).toString("base64url");
  return {
    token: `${body}.${sig}`,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    claims,
  };
}

function parseClaims(value: unknown): FlowCapabilityClaims | null {
  if (!value || typeof value !== "object") return null;
  const claims = value as Partial<FlowCapabilityClaims>;
  if (
    claims.typ !== "flow-action-lease" ||
    claims.v !== 1 ||
    typeof claims.callId !== "string" ||
    typeof claims.agentId !== "string" ||
    typeof claims.orgId !== "string" ||
    typeof claims.runtimeDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(claims.runtimeDigest) ||
    typeof claims.capabilityEpoch !== "number" ||
    !Number.isInteger(claims.capabilityEpoch) ||
    claims.capabilityEpoch < 0 ||
    typeof claims.step !== "string" ||
    typeof claims.attempt !== "number" ||
    !Number.isInteger(claims.attempt) ||
    claims.attempt < 0 ||
    typeof claims.tool !== "string" ||
    typeof claims.nonce !== "string" ||
    typeof claims.iat !== "number" ||
    !Number.isInteger(claims.iat) ||
    typeof claims.exp !== "number" ||
    !Number.isInteger(claims.exp)
  ) return null;
  return claims as FlowCapabilityClaims;
}

export function verifyFlowCapability(
  token: string,
  expected: CapabilitySubject,
  options: { secret?: string; nowMs?: number } = {}
): { claims: FlowCapabilityClaims } | FlowCapabilityError {
  const [body, encodedSignature, extra] = token.split(".");
  if (!body || !encodedSignature || extra) return { error: "malformed action capability", code: "invalid_capability" };
  try {
    const actual = Buffer.from(encodedSignature, "base64url");
    const wanted = signature(body, options.secret ?? actionCapabilitySecret());
    if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) {
      return { error: "invalid action capability signature", code: "invalid_capability" };
    }
    const claims = parseClaims(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
    if (!claims) return { error: "invalid action capability claims", code: "invalid_capability" };
    const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
    if (claims.exp <= nowSeconds) return { error: "action capability expired", code: "expired_capability" };
    if (claims.exp - claims.iat > MAX_FLOW_CAPABILITY_TTL_SECONDS || claims.iat > nowSeconds + 30) {
      return { error: "action capability lifetime is invalid", code: "capability_ttl_exceeded" };
    }
    for (const key of Object.keys(expected) as (keyof CapabilitySubject)[]) {
      if (claims[key] !== expected[key]) {
        return { error: `action capability does not match ${key}`, code: "capability_scope_mismatch" };
      }
    }
    return { claims };
  } catch {
    return { error: "invalid action capability", code: "invalid_capability" };
  }
}
