import "server-only";

import { randomBytes } from "node:crypto";
import {
  deriveRotatedScopedJti,
  signScope,
  type ScopeProvider,
} from "./voice";

export const CAPABILITY_ROTATION_TTL_SECONDS = 30 * 60;
export const CAPABILITY_ROTATION_OVERLAP_SECONDS = 5 * 60;
export const MAX_CAPABILITY_ROTATION = 1_000_000;

const JTI = /^[A-Za-z0-9_-]{22}$/;

export type CapabilityEnvelope<
  Audience extends string,
  Purpose extends string,
> = Readonly<{
  token: string;
  expires_at: string;
  audience: Audience;
  purpose: Purpose;
}>;

export type BrowserCapabilityRotationBundle = Readonly<{
  schema_version: 1;
  call_id: string;
  rotation: number;
  refresh_after: string;
  expires_at: string;
  mcp_capability: CapabilityEnvelope<"mcp", "tool-invocation">;
  renewal_capability: CapabilityEnvelope<"browser_refresh", "capability_rotation">;
}>;

export type BridgeCapabilityRotationBundle = Readonly<{
  schema_version: 1;
  session_id: string;
  bridge_instance_id: string;
  call_id: string;
  connection: Readonly<{
    account_sid: string;
    call_sid: string;
    stream_sid: string;
    mode: "agent";
  }>;
  rotation: number;
  refresh_after: string;
  expires_at: string;
  event_capability: CapabilityEnvelope<"telephony_events", "event_journal">;
  mcp_capability: CapabilityEnvelope<"bridge_mcp", "tool_invocation">;
  renewal_capability: CapabilityEnvelope<"bridge_refresh", "capability_rotation">;
}>;

type BaseBinding = Readonly<{
  callId: string;
  agentId: string;
  orgId: string;
  provider: Exclude<ScopeProvider, "twilio">;
}>;

export type BridgeCapabilityBinding = BaseBinding & Readonly<{
  sessionId: string;
  bridgeInstanceId: string;
  accountSid: string;
  callSid: string;
  to: string;
  streamSid: string;
}>;

export function newCapabilityRotationRoot(): string {
  return randomBytes(16).toString("base64url");
}

export function capabilityRotationTimes(issuedAt: number): Readonly<{
  issuedAt: number;
  refreshAfter: number;
  expiresAt: number;
  refreshAfterIso: string;
  expiresAtIso: string;
}> {
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) {
    throw new Error("capability rotation issuedAt must be a non-negative integer second");
  }
  const expiresAt = issuedAt + CAPABILITY_ROTATION_TTL_SECONDS;
  const refreshAfter = expiresAt - CAPABILITY_ROTATION_OVERLAP_SECONDS;
  return Object.freeze({
    issuedAt,
    refreshAfter,
    expiresAt,
    refreshAfterIso: new Date(refreshAfter * 1_000).toISOString(),
    expiresAtIso: new Date(expiresAt * 1_000).toISOString(),
  });
}

function validateGeneration(rootJti: string, generation: number): void {
  if (!JTI.test(rootJti)) throw new Error("capability rotation root is invalid");
  if (!Number.isSafeInteger(generation) || generation < 0 || generation > MAX_CAPABILITY_ROTATION) {
    throw new Error("capability rotation generation is invalid");
  }
}

function refreshJti(
  rootJti: string,
  generation: number,
  audience: "browser_refresh" | "bridge_refresh",
): string {
  // Generation zero deliberately uses the opaque root itself. That lets the
  // first browser renewal establish durable state without disclosing the root
  // anywhere other than the already-signed, short-lived refresh capability.
  return generation === 0
    ? rootJti
    : deriveRotatedScopedJti(rootJti, generation, audience);
}

export function issueBrowserCapabilityRotation(
  binding: BaseBinding,
  rootJti: string,
  generation: number,
  issuedAt: number,
): BrowserCapabilityRotationBundle {
  validateGeneration(rootJti, generation);
  const time = capabilityRotationTimes(issuedAt);
  const payload = { callId: binding.callId, agentId: binding.agentId, orgId: binding.orgId };
  const renewalToken = signScope(payload, {
    audience: "browser_refresh",
    purpose: "capability_rotation",
    method: "POST",
    provider: binding.provider,
    ttlSeconds: CAPABILITY_ROTATION_TTL_SECONDS,
    issuedAt,
    jti: refreshJti(rootJti, generation, "browser_refresh"),
  });
  const mcpToken = signScope(payload, {
    audience: "mcp",
    purpose: "tool-invocation",
    method: "POST",
    provider: binding.provider,
    ttlSeconds: CAPABILITY_ROTATION_TTL_SECONDS,
    issuedAt,
    jti: deriveRotatedScopedJti(rootJti, generation, "mcp"),
  });
  if (renewalToken === mcpToken) throw new Error("browser rotation capabilities must be distinct");
  return Object.freeze({
    schema_version: 1,
    call_id: binding.callId,
    rotation: generation,
    refresh_after: time.refreshAfterIso,
    expires_at: time.expiresAtIso,
    mcp_capability: Object.freeze({
      token: mcpToken,
      expires_at: time.expiresAtIso,
      audience: "mcp",
      purpose: "tool-invocation",
    }),
    renewal_capability: Object.freeze({
      token: renewalToken,
      expires_at: time.expiresAtIso,
      audience: "browser_refresh",
      purpose: "capability_rotation",
    }),
  });
}

export function issueBridgeCapabilityRotation(
  binding: BridgeCapabilityBinding,
  rootJti: string,
  generation: number,
  issuedAt: number,
): BridgeCapabilityRotationBundle {
  validateGeneration(rootJti, generation);
  const time = capabilityRotationTimes(issuedAt);
  const payload = { callId: binding.callId, agentId: binding.agentId, orgId: binding.orgId };
  const transport = {
    providerCallId: binding.callSid,
    providerAccountId: binding.accountSid,
    providerTo: binding.to,
    providerStreamId: binding.streamSid,
  } as const;
  const renewalToken = signScope(payload, {
    audience: "bridge_refresh",
    purpose: "capability_rotation",
    method: "POST",
    provider: binding.provider,
    ttlSeconds: CAPABILITY_ROTATION_TTL_SECONDS,
    issuedAt,
    jti: refreshJti(rootJti, generation, "bridge_refresh"),
    ...transport,
    transportProvider: "twilio",
  });
  const mcpToken = signScope(payload, {
    audience: "bridge_mcp",
    purpose: "tool_invocation",
    method: "POST",
    provider: binding.provider,
    ttlSeconds: CAPABILITY_ROTATION_TTL_SECONDS,
    issuedAt,
    jti: deriveRotatedScopedJti(rootJti, generation, "bridge_mcp"),
    ...transport,
    transportProvider: "twilio",
  });
  const eventToken = signScope(payload, {
    audience: "telephony_events",
    purpose: "event_journal",
    method: "POST",
    provider: "twilio",
    ttlSeconds: CAPABILITY_ROTATION_TTL_SECONDS,
    issuedAt,
    jti: deriveRotatedScopedJti(rootJti, generation, "telephony_events"),
    ...transport,
  });
  if (new Set([renewalToken, mcpToken, eventToken]).size !== 3) {
    throw new Error("bridge rotation capabilities must be pairwise distinct");
  }
  return Object.freeze({
    schema_version: 1,
    session_id: binding.sessionId,
    bridge_instance_id: binding.bridgeInstanceId,
    call_id: binding.callId,
    connection: Object.freeze({
      account_sid: binding.accountSid,
      call_sid: binding.callSid,
      stream_sid: binding.streamSid,
      mode: "agent",
    }),
    rotation: generation,
    refresh_after: time.refreshAfterIso,
    expires_at: time.expiresAtIso,
    event_capability: Object.freeze({
      token: eventToken,
      expires_at: time.expiresAtIso,
      audience: "telephony_events",
      purpose: "event_journal",
    }),
    mcp_capability: Object.freeze({
      token: mcpToken,
      expires_at: time.expiresAtIso,
      audience: "bridge_mcp",
      purpose: "tool_invocation",
    }),
    renewal_capability: Object.freeze({
      token: renewalToken,
      expires_at: time.expiresAtIso,
      audience: "bridge_refresh",
      purpose: "capability_rotation",
    }),
  });
}
