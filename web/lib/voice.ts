// Author: Harsha Gundala
// voice.ts — builds xAI realtime session configs for bots; scoped MCP tokens; call rows.
// Session build also resolves A/B experiment variants and injects caller CRM context.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mcpGatewaySecret } from "./high-authority-secrets";
import { q, qOne } from "./db";
import { pickVariant } from "./experiments";
import { findCustomerByPhone, phoneDigits } from "./datasets";
import { resolveVoiceProviderConfig } from "./realtime/config";
import { buildProviderSessionUpdate } from "./realtime/registry";
import { assertBrowserVoiceSessionAdmission } from "./realtime/browser-session-admission";
import type {
  BrowserProviderFundingAuthority,
  RealtimeAudioFormat,
  RemoteMcpServer,
  VoiceSessionSpec,
} from "./realtime/types";
import {
  AgentFlowSchema,
} from "./flow";
import {
  assertFlowToolCatalogClosure,
  assertUniqueToolCatalog,
  baseBuiltInVoiceActionNames,
  consequentialBuiltInVoiceActionNames,
  FLOW_CONTROL_TOOL_NAMES,
  type ToolCatalogIdentity,
} from "./flow-tool-catalog";
import { hasReadyDocuments } from "./knowledge";
import { voiceToolExtensions } from "./voice-tools";
import {
  CallRuntimeSnapshotSchema,
  callRuntimeDigest,
  isPinnedExternalMcpManifest,
  parseCallRuntimeSnapshot,
  type CallRuntimeSnapshot,
} from "./call-runtime-snapshot";
import {
  approvedExternalMcpManifest,
  MAX_ATTACHED_REMOTE_MCP_SERVERS,
  MAX_REMOTE_MCP_MANIFEST_BYTES_PER_CALL,
  MAX_REMOTE_MCP_TOOLS_PER_CALL,
  verifyPinnedExternalMcpManifest,
  type McpRegistryServer,
} from "./remote-mcp-runtime";
import { requirePublicOrigin } from "./public-origin";
import {
  activeCapabilityCatalogInstructions,
  type ActiveCapabilityCatalog,
} from "./active-capability-catalog";
import { durableContextPacketInstructions } from "./live-conversation-route";

export type AgentVersionRow = {
  agent_id: string;
  org_id: string;
  name: string;
  version: number;
  instructions: string;
  voice: string;
  flow: unknown;
  tool_ids: string[];
  mcp_server_ids: string[];
  settings: Record<string, unknown>;
  created_at: string;
};

export async function loadActiveAgent(agentId: string, orgId: string): Promise<AgentVersionRow | null> {
  return qOne<AgentVersionRow>(
    `SELECT a.id AS agent_id, a.org_id, a.name, v.version, v.instructions, v.voice, v.flow,
            v.tool_ids, v.mcp_server_ids, v.settings, v.created_at
     FROM agents a JOIN agent_versions v ON v.agent_id = a.id AND v.version = a.active_version
     WHERE a.id = $1 AND a.org_id = $2`,
    [agentId, orgId]
  );
}

async function loadAgentVersion(agent: AgentVersionRow, version: number): Promise<AgentVersionRow | null> {
  const v = await qOne<Pick<AgentVersionRow, "version" | "instructions" | "voice" | "flow" | "tool_ids" | "mcp_server_ids" | "settings" | "created_at">>(
    `SELECT version, instructions, voice, flow, tool_ids, mcp_server_ids, settings, created_at
     FROM agent_versions WHERE agent_id = $1 AND version = $2`,
    [agent.agent_id, version]
  );
  return v ? { ...agent, ...v } : null;
}

export const SCOPE_AUDIENCES = [
  "mcp",
  "browser_refresh",
  "bridge_mcp",
  "bridge_refresh",
  "bridge_bootstrap",
  "twilio-bridge",
  "telephony_events",
  "telephony-transfer",
] as const;
export type ScopeAudience = (typeof SCOPE_AUDIENCES)[number];

export const SCOPE_PROVIDERS = ["xai", "openai", "gemini", "twilio"] as const;
export type ScopeProvider = (typeof SCOPE_PROVIDERS)[number];
export type ScopeMethod = "GET" | "POST";

const PURPOSE_BY_AUDIENCE = {
  mcp: "tool-invocation",
  browser_refresh: "capability_rotation",
  bridge_mcp: "tool_invocation",
  bridge_refresh: "capability_rotation",
  bridge_bootstrap: "telephony_stream_exchange",
  "twilio-bridge": "media-stream",
  telephony_events: "event_journal",
  "telephony-transfer": "human-transfer",
} as const satisfies Record<ScopeAudience, string>;
export type ScopePurpose = (typeof PURPOSE_BY_AUDIENCE)[ScopeAudience];

const MAX_TTL_BY_AUDIENCE: Record<ScopeAudience, number> = {
  mcp: 30 * 60,
  browser_refresh: 30 * 60,
  bridge_mcp: 30 * 60,
  bridge_refresh: 30 * 60,
  bridge_bootstrap: 5 * 60,
  "twilio-bridge": 5 * 60,
  telephony_events: 30 * 60,
  "telephony-transfer": 2 * 60,
};
const SCOPE_CLOCK_SKEW_SECONDS = 10;
const SCOPE_SIGNATURE_DOMAIN = "harshas-amazing-call-center/capability/v2\n";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CALL_SID_PATTERN = /^CA[0-9a-fA-F]{32}$/;
const ACCOUNT_SID_PATTERN = /^AC[0-9a-fA-F]{32}$/;
const STREAM_SID_PATTERN = /^MZ[0-9a-fA-F]{32}$/;
const PHONE_PATTERN = /^\+[1-9]\d{6,14}$/;
const JTI_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const AUDIENCE_CODE: Record<ScopeAudience, string> = {
  mcp: "mc",
  browser_refresh: "br",
  bridge_mcp: "bm",
  bridge_refresh: "rr",
  bridge_bootstrap: "bb",
  "twilio-bridge": "tb",
  telephony_events: "te",
  "telephony-transfer": "tt",
};
const PROVIDER_CODE: Record<ScopeProvider, string> = { xai: "x", openai: "o", gemini: "g", twilio: "t" };
const PURPOSE_CODE: Record<ScopePurpose, string> = {
  "tool-invocation": "ti",
  capability_rotation: "cr",
  tool_invocation: "bi",
  telephony_stream_exchange: "tx",
  "media-stream": "ms",
  event_journal: "ej",
  "human-transfer": "ht",
};

export type ScopeClaims = {
  v: 2;
  callId: string;
  agentId: string;
  orgId: string;
  aud: ScopeAudience;
  purpose: ScopePurpose;
  method: ScopeMethod;
  provider: ScopeProvider;
  iat: number;
  exp: number;
  jti: string;
  providerCallId?: string;
  providerAccountId?: string;
  providerTo?: string;
  bridgeMode?: "agent" | "observe";
  authorizedTarget?: string;
  providerStreamId?: string;
  transportProvider?: "twilio";
  bridgeOriginSha256?: string;
};

export type ScopeOptions = {
  audience: ScopeAudience;
  purpose: ScopePurpose;
  method: ScopeMethod;
  provider: ScopeProvider;
  ttlSeconds: number;
  providerCallId?: string;
  providerAccountId?: string;
  providerTo?: string;
  bridgeMode?: "agent" | "observe";
  authorizedTarget?: string;
  providerStreamId?: string;
  transportProvider?: "twilio";
  bridgeOriginSha256?: string;
  issuedAt?: number;
  jti?: string;
};

export type ScopeExpectation = {
  audience: ScopeAudience;
  purpose: ScopePurpose;
  method: ScopeMethod;
  provider: ScopeProvider | readonly ScopeProvider[];
  callId?: string;
  agentId?: string;
  orgId?: string;
  providerCallId?: string;
  providerAccountId?: string;
  providerTo?: string;
  bridgeMode?: "agent" | "observe";
  authorizedTarget?: string;
  providerStreamId?: string;
  transportProvider?: "twilio";
  bridgeOriginSha256?: string;
};

function scopeSecret(): string {
  return mcpGatewaySecret();
}

function canonicalScopeClaims(claims: ScopeClaims): ScopeClaims {
  const base: ScopeClaims = {
    v: 2,
    callId: claims.callId,
    agentId: claims.agentId,
    orgId: claims.orgId,
    aud: claims.aud,
    purpose: claims.purpose,
    method: claims.method,
    provider: claims.provider,
    iat: claims.iat,
    exp: claims.exp,
    jti: claims.jti,
  };
  if (claims.providerCallId !== undefined) base.providerCallId = claims.providerCallId;
  if (claims.providerAccountId !== undefined) base.providerAccountId = claims.providerAccountId;
  if (claims.providerTo !== undefined) base.providerTo = claims.providerTo;
  if (claims.bridgeMode !== undefined) base.bridgeMode = claims.bridgeMode;
  if (claims.authorizedTarget !== undefined) base.authorizedTarget = claims.authorizedTarget;
  if (claims.providerStreamId !== undefined) base.providerStreamId = claims.providerStreamId;
  if (claims.transportProvider !== undefined) base.transportProvider = claims.transportProvider;
  if (claims.bridgeOriginSha256 !== undefined) base.bridgeOriginSha256 = claims.bridgeOriginSha256;
  return base;
}

function compactUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error("invalid uuid claim");
  return Buffer.from(value.replaceAll("-", ""), "hex").toString("base64url");
}

function expandUuid(value: unknown): string {
  if (typeof value !== "string" || !JTI_PATTERN.test(value)) throw new Error("invalid compact uuid");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength !== 16 || bytes.toString("base64url") !== value) throw new Error("non-canonical compact uuid");
  const hex = bytes.toString("hex");
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (!UUID_PATTERN.test(uuid)) throw new Error("invalid compact uuid value");
  return uuid;
}

function compactSid(value: string, pattern: RegExp): string {
  if (!pattern.test(value)) throw new Error("invalid provider sid claim");
  return Buffer.from(value.slice(2), "hex").toString("base64url");
}

function expandSid(value: unknown, prefix: "CA" | "AC" | "MZ"): string {
  if (typeof value !== "string" || !JTI_PATTERN.test(value)) throw new Error("invalid compact provider sid");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength !== 16 || bytes.toString("base64url") !== value) throw new Error("non-canonical provider sid");
  return `${prefix}${bytes.toString("hex")}`;
}

function compactSha256(value: string): string {
  if (!SHA256_PATTERN.test(value)) throw new Error("invalid sha256 claim");
  return Buffer.from(value, "hex").toString("base64url");
}

function expandSha256(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error("invalid compact sha256");
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength !== 32 || bytes.toString("base64url") !== value) {
    throw new Error("non-canonical compact sha256");
  }
  return bytes.toString("hex");
}

type ScopeWire = Record<string, string | number> & { v: 2 };

function scopeWire(claims: ScopeClaims): ScopeWire {
  const wire: ScopeWire = {
    v: 2,
    c: compactUuid(claims.callId),
    a: compactUuid(claims.agentId),
    o: compactUuid(claims.orgId),
    u: AUDIENCE_CODE[claims.aud],
    p: PURPOSE_CODE[claims.purpose],
    h: claims.method === "GET" ? "G" : "P",
    r: PROVIDER_CODE[claims.provider],
    i: claims.iat,
    e: claims.exp,
    j: claims.jti,
  };
  if (claims.providerCallId !== undefined) wire.x = compactSid(claims.providerCallId, CALL_SID_PATTERN);
  if (claims.providerAccountId !== undefined) wire.y = compactSid(claims.providerAccountId, ACCOUNT_SID_PATTERN);
  if (claims.providerTo !== undefined) wire.t = claims.providerTo;
  if (claims.bridgeMode !== undefined) wire.m = claims.bridgeMode === "agent" ? "a" : "o";
  if (claims.authorizedTarget !== undefined) wire.d = claims.authorizedTarget;
  if (claims.providerStreamId !== undefined) wire.s = compactSid(claims.providerStreamId, STREAM_SID_PATTERN);
  if (claims.transportProvider !== undefined) wire.q = PROVIDER_CODE[claims.transportProvider];
  if (claims.bridgeOriginSha256 !== undefined) wire.b = compactSha256(claims.bridgeOriginSha256);
  return wire;
}

function claimsFromWire(candidate: unknown): ScopeClaims {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("invalid scope body");
  const wire = candidate as Record<string, unknown>;
  const audience = (Object.entries(AUDIENCE_CODE).find(([, code]) => code === wire.u)?.[0]) as ScopeAudience | undefined;
  const purpose = (Object.entries(PURPOSE_CODE).find(([, code]) => code === wire.p)?.[0]) as ScopePurpose | undefined;
  const provider = (Object.entries(PROVIDER_CODE).find(([, code]) => code === wire.r)?.[0]) as ScopeProvider | undefined;
  if (wire.v !== 2 || !audience || !purpose || !provider) throw new Error("invalid scope codes");
  const expectedKeys = [
    "v", "c", "a", "o", "u", "p", "h", "r", "i", "e", "j",
    ...(audience === "mcp" || audience === "browser_refresh" ? [] : ["x", "y", "t"]),
    ...(audience === "twilio-bridge" ? ["m"] : []),
    ...(audience === "telephony-transfer" ? ["d"] : []),
    ...(audience === "bridge_mcp" || audience === "bridge_refresh" || audience === "telephony_events" ? ["s"] : []),
    ...(audience === "bridge_mcp" || audience === "bridge_refresh" ? ["q"] : []),
    ...(audience === "bridge_bootstrap" ? ["b"] : []),
  ].sort();
  if (Object.keys(wire).sort().join("\0") !== expectedKeys.join("\0")) throw new Error("unexpected scope claims");
  const claims = canonicalScopeClaims({
    v: 2,
    callId: expandUuid(wire.c),
    agentId: expandUuid(wire.a),
    orgId: expandUuid(wire.o),
    aud: audience,
    purpose,
    method: wire.h === "G" ? "GET" : wire.h === "P" ? "POST" : (() => { throw new Error("invalid method"); })(),
    provider,
    iat: wire.i as number,
    exp: wire.e as number,
    jti: String(wire.j ?? ""),
    providerCallId: audience === "mcp" || audience === "browser_refresh" ? undefined : expandSid(wire.x, "CA"),
    providerAccountId: audience === "mcp" || audience === "browser_refresh" ? undefined : expandSid(wire.y, "AC"),
    providerTo: audience === "mcp" || audience === "browser_refresh" ? undefined : String(wire.t ?? ""),
    bridgeMode: audience === "twilio-bridge"
      ? wire.m === "a" ? "agent" : wire.m === "o" ? "observe" : (() => { throw new Error("invalid bridge mode"); })()
      : undefined,
    authorizedTarget: audience === "telephony-transfer" ? String(wire.d ?? "") : undefined,
    providerStreamId: audience === "bridge_mcp" || audience === "bridge_refresh" || audience === "telephony_events"
      ? expandSid(wire.s, "MZ")
      : undefined,
    transportProvider: audience === "bridge_mcp" || audience === "bridge_refresh"
      ? wire.q === PROVIDER_CODE.twilio ? "twilio" : (() => { throw new Error("invalid transport provider"); })()
      : undefined,
    bridgeOriginSha256: audience === "bridge_bootstrap" ? expandSha256(wire.b) : undefined,
  });
  if (!validScopeShape(claims)) throw new Error("invalid scope claims");
  return claims;
}

function validScopeShape(candidate: unknown): candidate is ScopeClaims {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const claims = candidate as Partial<ScopeClaims>;
  if (
    claims.v !== 2 ||
    typeof claims.callId !== "string" || !UUID_PATTERN.test(claims.callId) ||
    typeof claims.agentId !== "string" || !UUID_PATTERN.test(claims.agentId) ||
    typeof claims.orgId !== "string" || !UUID_PATTERN.test(claims.orgId) ||
    !SCOPE_AUDIENCES.includes(claims.aud as ScopeAudience) ||
    !SCOPE_PROVIDERS.includes(claims.provider as ScopeProvider) ||
    (claims.method !== "GET" && claims.method !== "POST") ||
    typeof claims.purpose !== "string" ||
    PURPOSE_BY_AUDIENCE[claims.aud as ScopeAudience] !== claims.purpose ||
    !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) ||
    typeof claims.jti !== "string" || !JTI_PATTERN.test(claims.jti)
  ) return false;

  const expectedKeys = [
    "v", "callId", "agentId", "orgId", "aud", "purpose", "method", "provider",
    "iat", "exp", "jti",
    ...(claims.providerCallId === undefined ? [] : ["providerCallId"]),
    ...(claims.providerAccountId === undefined ? [] : ["providerAccountId"]),
    ...(claims.providerTo === undefined ? [] : ["providerTo"]),
    ...(claims.bridgeMode === undefined ? [] : ["bridgeMode"]),
    ...(claims.authorizedTarget === undefined ? [] : ["authorizedTarget"]),
    ...(claims.providerStreamId === undefined ? [] : ["providerStreamId"]),
    ...(claims.transportProvider === undefined ? [] : ["transportProvider"]),
    ...(claims.bridgeOriginSha256 === undefined ? [] : ["bridgeOriginSha256"]),
  ].sort();
  if (Object.keys(claims).sort().join("\0") !== expectedKeys.join("\0")) return false;

  const transportBound = claims.aud !== "mcp" && claims.aud !== "browser_refresh";
  if (transportBound) {
    if (
      typeof claims.providerCallId !== "string" || !CALL_SID_PATTERN.test(claims.providerCallId) ||
      typeof claims.providerAccountId !== "string" || !ACCOUNT_SID_PATTERN.test(claims.providerAccountId) ||
      typeof claims.providerTo !== "string" || !PHONE_PATTERN.test(claims.providerTo) ||
      (claims.aud === "twilio-bridge"
        ? claims.bridgeMode !== "agent" && claims.bridgeMode !== "observe"
        : claims.bridgeMode !== undefined) ||
      (claims.aud === "telephony-transfer"
        ? typeof claims.authorizedTarget !== "string" || !PHONE_PATTERN.test(claims.authorizedTarget)
        : claims.authorizedTarget !== undefined) ||
      (claims.aud === "bridge_mcp" || claims.aud === "bridge_refresh" || claims.aud === "telephony_events"
        ? typeof claims.providerStreamId !== "string" || !STREAM_SID_PATTERN.test(claims.providerStreamId)
        : claims.providerStreamId !== undefined) ||
      (claims.aud === "bridge_mcp" || claims.aud === "bridge_refresh"
        ? claims.transportProvider !== "twilio" || claims.provider === "twilio"
        : claims.transportProvider !== undefined) ||
      (claims.aud === "bridge_bootstrap"
        ? typeof claims.bridgeOriginSha256 !== "string" || !SHA256_PATTERN.test(claims.bridgeOriginSha256)
        : claims.bridgeOriginSha256 !== undefined) ||
      (claims.aud !== "bridge_mcp" && claims.aud !== "bridge_refresh" && claims.provider !== "twilio")
    ) return false;
  } else if (
    claims.providerCallId !== undefined ||
    claims.providerAccountId !== undefined ||
    claims.providerTo !== undefined || claims.bridgeMode !== undefined || claims.authorizedTarget !== undefined ||
    claims.providerStreamId !== undefined || claims.transportProvider !== undefined ||
    claims.bridgeOriginSha256 !== undefined ||
    claims.provider === "twilio"
  ) return false;

  const expectedMethod: Record<ScopeAudience, ScopeMethod> = {
    mcp: "POST",
    browser_refresh: "POST",
    bridge_mcp: "POST",
    bridge_refresh: "POST",
    bridge_bootstrap: "POST",
    "twilio-bridge": "GET",
    telephony_events: "POST",
    "telephony-transfer": "GET",
  };
  if (claims.method !== expectedMethod[claims.aud as ScopeAudience]) return false;
  return true;
}

/** Deterministically derives a narrow child-capability id without persisting bearer material. */
export function deriveScopedJti(parentJti: string, audience: ScopeAudience): string {
  if (!JTI_PATTERN.test(parentJti) || !SCOPE_AUDIENCES.includes(audience)) {
    throw new Error("invalid child capability derivation input");
  }
  return createHmac("sha256", scopeSecret())
    .update("harshas-amazing-call-center/capability-child-jti/v1\n", "utf8")
    .update(parentJti, "ascii")
    .update("\n", "ascii")
    .update(AUDIENCE_CODE[audience], "ascii")
    .digest()
    .subarray(0, 16)
    .toString("base64url");
}

/**
 * Derives one generation-specific capability id from a durable rotation root.
 * The generation and audience are part of the MAC domain, so refresh, MCP,
 * and journal capabilities are pairwise distinct without storing bearer bytes.
 */
export function deriveRotatedScopedJti(
  rotationRootJti: string,
  generation: number,
  audience: ScopeAudience
): string {
  if (
    !JTI_PATTERN.test(rotationRootJti) ||
    !Number.isSafeInteger(generation) || generation < 0 || generation > 1_000_000 ||
    !SCOPE_AUDIENCES.includes(audience)
  ) {
    throw new Error("invalid rotated capability derivation input");
  }
  return createHmac("sha256", scopeSecret())
    .update("harshas-amazing-call-center/capability-rotation-jti/v1\n", "utf8")
    .update(rotationRootJti, "ascii")
    .update("\n", "ascii")
    .update(String(generation), "ascii")
    .update("\n", "ascii")
    .update(AUDIENCE_CODE[audience], "ascii")
    .digest()
    .subarray(0, 16)
    .toString("base64url");
}

/** Domain-separated, short-lived call capability. Unbound v1 scopes are intentionally rejected. */
export function signScope(
  payload: { callId: string; agentId: string; orgId: string },
  options: ScopeOptions
): string {
  if (PURPOSE_BY_AUDIENCE[options.audience] !== options.purpose) {
    throw new Error("scope purpose does not match its audience");
  }
  const maxTtl = MAX_TTL_BY_AUDIENCE[options.audience];
  if (!Number.isSafeInteger(options.ttlSeconds) || options.ttlSeconds < 1 || options.ttlSeconds > maxTtl) {
    throw new Error(`scope ttl must be between 1 and ${maxTtl} seconds for ${options.audience}`);
  }
  const now = Math.floor(Date.now() / 1000);
  const issuedAt = options.issuedAt ?? now;
  const jti = options.jti ?? randomBytes(16).toString("base64url");
  if (!Number.isSafeInteger(issuedAt) || issuedAt > now + SCOPE_CLOCK_SKEW_SECONDS || !JTI_PATTERN.test(jti)) {
    throw new Error("invalid scope issuance metadata");
  }
  const claims = canonicalScopeClaims({
    v: 2,
    ...payload,
    aud: options.audience,
    purpose: options.purpose,
    method: options.method,
    provider: options.provider,
    iat: issuedAt,
    exp: issuedAt + options.ttlSeconds,
    jti,
    providerCallId: options.providerCallId,
    providerAccountId: options.providerAccountId,
    providerTo: options.providerTo,
    bridgeMode: options.bridgeMode,
    authorizedTarget: options.authorizedTarget,
    providerStreamId: options.providerStreamId,
    transportProvider: options.transportProvider,
    bridgeOriginSha256: options.bridgeOriginSha256,
  });
  if (!validScopeShape(claims)) throw new Error("invalid scope claims");
  const body = Buffer.from(JSON.stringify(scopeWire(claims)), "utf8").toString("base64url");
  const sig = createHmac("sha256", scopeSecret())
    .update(SCOPE_SIGNATURE_DOMAIN, "utf8")
    .update(body, "ascii")
    .digest("base64url");
  return `${body}.${sig}`;
}

export function verifyScope(token: string, expected: ScopeExpectation): ScopeClaims | null {
  if (typeof token !== "string" || token.length < 80 || token.length > 4_096 || /\s/.test(token)) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return null;
  try {
    const encoded = Buffer.from(body, "base64url");
    if (encoded.toString("base64url") !== body || encoded.byteLength > 2_048) return null;
    const expect = createHmac("sha256", scopeSecret())
      .update(SCOPE_SIGNATURE_DOMAIN, "utf8")
      .update(body, "ascii")
      .digest();
    const actual = Buffer.from(sig, "base64url");
    if (actual.length !== expect.length || !timingSafeEqual(actual, expect)) return null;
    const claims = claimsFromWire(JSON.parse(encoded.toString("utf8")));
    if (JSON.stringify(scopeWire(claims)) !== encoded.toString("utf8")) return null;
    const now = Math.floor(Date.now() / 1000);
    if (
      claims.iat > now + SCOPE_CLOCK_SKEW_SECONDS ||
      claims.exp <= now ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > MAX_TTL_BY_AUDIENCE[claims.aud] ||
      claims.aud !== expected.audience ||
      claims.purpose !== expected.purpose ||
      claims.method !== expected.method ||
      !(Array.isArray(expected.provider)
        ? expected.provider.includes(claims.provider)
        : claims.provider === expected.provider) ||
      (expected.callId !== undefined && claims.callId !== expected.callId) ||
      (expected.agentId !== undefined && claims.agentId !== expected.agentId) ||
      (expected.orgId !== undefined && claims.orgId !== expected.orgId) ||
      (expected.providerCallId !== undefined && claims.providerCallId !== expected.providerCallId) ||
      (expected.providerAccountId !== undefined && claims.providerAccountId !== expected.providerAccountId) ||
      (expected.providerTo !== undefined && claims.providerTo !== expected.providerTo) ||
      (expected.bridgeMode !== undefined && claims.bridgeMode !== expected.bridgeMode) ||
      (expected.authorizedTarget !== undefined && claims.authorizedTarget !== expected.authorizedTarget) ||
      (expected.providerStreamId !== undefined && claims.providerStreamId !== expected.providerStreamId) ||
      (expected.transportProvider !== undefined && claims.transportProvider !== expected.transportProvider) ||
      (expected.bridgeOriginSha256 !== undefined && claims.bridgeOriginSha256 !== expected.bridgeOriginSha256)
    ) return null;
    return claims;
  } catch {
    return null;
  }
}

type CallRow = {
  direction: string;
  from_number: string | null;
  to_number: string | null;
  experiment_id: string | null;
  variant: string | null;
  agent_version: number;
  flow_id: string | null;
  runtime_snapshot: unknown | null;
  runtime_digest: string | null;
  started_at: Date | string;
};

/** Honors a stamped experiment variant, or lazily picks one (covers PSTN calls created outside buildVoiceSession). */
async function resolveVariant(agent: AgentVersionRow, callId: string, call: CallRow | null): Promise<AgentVersionRow> {
  if (!call) return agent;
  // Scheduled/operator-authorized calls carry an immutable runtime snapshot and
  // exact agent version. Never repick an experiment or consult current config.
  if (call.runtime_snapshot) {
    if (call.agent_version === agent.version) return agent;
    const pinned = await loadAgentVersion(agent, call.agent_version);
    if (!pinned) throw new Error("pinned call agent version is unavailable");
    return pinned;
  }
  let version: number | null = call.experiment_id ? call.agent_version : null;
  if (!call.experiment_id) {
    const pick = await pickVariant(agent.agent_id).catch(() => null);
    if (pick) {
      version = pick.agentVersion;
      await q(
        "UPDATE calls SET experiment_id = $2, variant = $3, agent_version = $4 WHERE id = $1",
        [callId, pick.experimentId, pick.variant, pick.agentVersion]
      );
    }
  }
  if (version && version !== agent.version) {
    return (await loadAgentVersion(agent, version)) ?? agent;
  }
  return agent;
}

/** CRM lookup + recent-call history for the caller's number; empty string when unknown (web calls). */
async function callerContextBlock(orgId: string, callId: string, call: CallRow | null): Promise<string> {
  const number = call?.direction === "outbound" ? call?.to_number : call?.from_number;
  if (!number) return "";
  const digits = phoneDigits(number);
  if (digits.length < 7) return "";

  const [customer, recent] = await Promise.all([
    findCustomerByPhone(orgId, number).catch(() => null),
    q<{ started_at: string; summary: string | null; satisfaction: number | null }>(
      `SELECT c.started_at, c.summary, c.satisfaction
       FROM calls c JOIN agents a ON a.id = c.agent_id
       WHERE a.org_id = $1 AND c.id <> $2 AND c.status = 'completed'
         AND RIGHT(regexp_replace(COALESCE(CASE WHEN c.direction = 'outbound' THEN c.to_number ELSE c.from_number END, ''), '\\D', '', 'g'), 10) = RIGHT($3, 10)
       ORDER BY c.started_at DESC LIMIT 3`,
      [orgId, callId, digits]
    ).catch(() => []),
  ]);
  if (!customer && !recent.length) return "";

  const lines = ["CALLER CONTEXT (from CRM):"];
  if (customer) {
    const bits = ["name", "email", "notes"]
      .filter((k) => customer[k])
      .map((k) => `${k}: ${String(customer[k]).slice(0, 200)}`);
    lines.push(bits.length ? bits.join(", ") : "known customer (no details on file)");
  } else {
    lines.push("not in the customers table");
  }
  if (recent.length) {
    lines.push("recent calls:");
    for (const r of recent) {
      lines.push(
        `- ${new Date(r.started_at).toISOString().slice(0, 10)}: ${r.summary ?? "no summary"}${r.satisfaction != null ? ` (satisfaction ${r.satisfaction}/10)` : ""}`
      );
    }
  }
  lines.push("Greet them by name if known.");
  return `${lines.join("\n")}\n\n`;
}

const BASE_VOICE_ACTIONS = new Set(baseBuiltInVoiceActionNames());
const MAX_BATCH_RUNTIME_ADMISSIONS = 5_000;
const RUNTIME_ADMISSION_BATCH_CONCURRENCY = 25;

function assertRuntimeSnapshotToolClosure(snapshot: CallRuntimeSnapshot): void {
  const availableActions = new Set<string>(BASE_VOICE_ACTIONS);
  const catalogIdentities: ToolCatalogIdentity[] = [
    ...[...FLOW_CONTROL_TOOL_NAMES].map((name) => ({ name, source: "flow control plane" })),
    ...[...BASE_VOICE_ACTIONS].map((name) => ({ name, source: "built-in voice tools" })),
  ];
  if (snapshot.environment.holdMusic) {
    availableActions.add("play_hold_music");
    catalogIdentities.push({ name: "play_hold_music", source: "built-in voice tools" });
  }
  if (snapshot.environment.internetEnabled) {
    availableActions.add("search");
    catalogIdentities.push({ name: "search", source: "built-in voice tools" });
  }
  if (snapshot.environment.docsReady) {
    availableActions.add("search_knowledge");
    catalogIdentities.push({ name: "search_knowledge", source: "built-in voice tools" });
  }
  for (const tool of snapshot.toolManifest) {
    availableActions.add(tool.slug);
    catalogIdentities.push({ name: tool.slug, source: `generated tool ${tool.id}` });
  }
  for (const tool of snapshot.extensionManifest) {
    availableActions.add(tool.name);
    catalogIdentities.push({ name: tool.name, source: "source extension" });
  }
  const remoteNames = new Set<string>();
  for (const manifest of snapshot.externalMcpManifest) {
    if (!isPinnedExternalMcpManifest(manifest)) continue;
    for (const tool of manifest.tools) {
      availableActions.add(tool.name);
      remoteNames.add(tool.name);
      catalogIdentities.push({ name: tool.name, source: `MCP server ${manifest.id}` });
    }
  }
  assertUniqueToolCatalog(catalogIdentities);
  assertFlowToolCatalogClosure(snapshot.flow, availableActions, remoteNames, new Set([
    ...consequentialBuiltInVoiceActionNames(),
    ...remoteNames,
    ...snapshot.toolManifest.map((tool) => tool.slug),
    ...snapshot.extensionManifest
      .filter((tool) => tool.effect !== "read")
      .map((tool) => tool.name),
  ]));
}

async function buildRuntimeSnapshot(
  agent: AgentVersionRow,
  callId: string,
  flowId: string | null
): Promise<{ snapshot: CallRuntimeSnapshot; digest: string }> {
  if (agent.mcp_server_ids.length > MAX_ATTACHED_REMOTE_MCP_SERVERS) {
    throw new Error(`a call can attach at most ${MAX_ATTACHED_REMOTE_MCP_SERVERS} remote MCP servers`);
  }
  const [named, toolRows, mcpRows, org, docsReady, datasets, holdMusic, extensionManifest] = await Promise.all([
    flowId
      ? qOne<{ flow: unknown; instructions: string }>(
          "SELECT flow, instructions FROM flows WHERE id = $1 AND org_id = $2 AND agent_id = $3",
          [flowId, agent.org_id, agent.agent_id]
        )
      : Promise.resolve(null),
    agent.tool_ids.length
      ? q<{
          id: string;
          slug: string;
          description: string;
          input_schema: Record<string, unknown>;
          endpoint_url: string | null;
          deploy_status: string;
          invocation_key_id: string | null;
          invocation_revision_ready: boolean;
        }>(
          `SELECT t.id, t.slug, t.description, t.input_schema, t.endpoint_url, t.deploy_status,
                  t.invocation_key_id,
                  EXISTS (
                    SELECT 1 FROM tool_invocation_revisions r
                    WHERE r.tool_id = t.id
                      AND r.key_id = t.invocation_key_id
                      AND r.endpoint_url = t.endpoint_url
                      AND r.status = 'live'
                      AND r.revoked_at IS NULL
                      AND r.private_key_encrypted IS NOT NULL
                  ) AS invocation_revision_ready
           FROM tools t WHERE t.id = ANY($1) AND t.org_id = $2`,
          [agent.tool_ids, agent.org_id]
        )
      : Promise.resolve([]),
    agent.mcp_server_ids.length
      ? q<McpRegistryServer>(
          `SELECT id, org_id, label, server_url, allowed_tools, auth_header_encrypted,
                  auth_encryption_slot_id,
                  approved_manifest, approved_catalog_hash,
                  revoked_at, revoked_by, revocation_reason
           FROM mcp_servers WHERE id = ANY($1) AND org_id = $2`,
          [agent.mcp_server_ids, agent.org_id]
        )
      : Promise.resolve([]),
    qOne<{ internet_enabled: boolean; allowed_domains: string[] }>(
      "SELECT internet_enabled, allowed_domains FROM orgs WHERE id = $1",
      [agent.org_id]
    ),
    hasReadyDocuments(agent.org_id),
    q<{ slug: string }>("SELECT slug FROM datasets WHERE org_id = $1 ORDER BY created_at", [agent.org_id]),
    qOne<{ ok: number }>(
      `SELECT 1 AS ok FROM media_renditions mr JOIN documents d ON d.id = mr.document_id
       WHERE d.org_id = $1 AND d.meta->>'hold_music' = 'true' AND mr.kind = 'ulaw8k' LIMIT 1`,
      [agent.org_id]
    ),
    voiceToolExtensions.definitions({ callId, agentId: agent.agent_id, orgId: agent.org_id }),
  ]);
  if (flowId && !named) throw new Error("named flow is missing or does not belong to this agent");
  const flow = AgentFlowSchema.parse(named?.flow ?? agent.flow);
  const toolsById = new Map(toolRows.map((tool) => [tool.id, tool]));
  const mcpById = new Map(mcpRows.map((server) => [server.id, server]));
  if (new Set(agent.tool_ids).size !== agent.tool_ids.length ||
      agent.tool_ids.some((id) => {
        const tool = toolsById.get(id);
        return !tool || tool.deploy_status !== "live" || !tool.endpoint_url ||
          !tool.invocation_key_id || !tool.invocation_revision_ready;
      })) {
    throw new Error("an attached minted tool is duplicated, missing, outside this organization, or not live");
  }
  if (new Set(agent.mcp_server_ids).size !== agent.mcp_server_ids.length ||
      agent.mcp_server_ids.some((id) => !mcpById.has(id))) {
    throw new Error("an attached MCP server is duplicated, missing, or outside this organization");
  }
  // The registration-approved catalog is immutable for this agent version. Call admission
  // live-verifies it; it never silently accepts whatever schema happens to exist today.
  const externalMcpManifest = agent.mcp_server_ids.map((id) =>
    approvedExternalMcpManifest(mcpById.get(id)!)
  );
  const remoteToolCount = externalMcpManifest.reduce((count, manifest) => count + manifest.tools.length, 0);
  const remoteManifestBytes = Buffer.byteLength(JSON.stringify(externalMcpManifest), "utf8");
  if (remoteToolCount > MAX_REMOTE_MCP_TOOLS_PER_CALL ||
      remoteManifestBytes > MAX_REMOTE_MCP_MANIFEST_BYTES_PER_CALL) {
    throw new Error("attached remote MCP catalogs exceed the per-call safety limit");
  }
  await Promise.all(externalMcpManifest.map((manifest) =>
    verifyPinnedExternalMcpManifest(manifest, agent.org_id, {
      loadServer: async (serverId, orgId) =>
        orgId === agent.org_id ? mcpById.get(serverId) ?? null : null,
    })
  ));
  // This catalog intentionally combines typed built-ins with extension, generated, and
  // namespaced MCP action names discovered below.
  const availableActions = new Set<string>(BASE_VOICE_ACTIONS);
  const catalogIdentities: ToolCatalogIdentity[] = [
    ...[...FLOW_CONTROL_TOOL_NAMES].map((name) => ({ name, source: "flow control plane" })),
    ...[...BASE_VOICE_ACTIONS].map((name) => ({ name, source: "built-in voice tools" })),
  ];
  if (holdMusic) {
    availableActions.add("play_hold_music");
    catalogIdentities.push({ name: "play_hold_music", source: "built-in voice tools" });
  }
  if (org?.internet_enabled) {
    availableActions.add("search");
    catalogIdentities.push({ name: "search", source: "built-in voice tools" });
  }
  if (docsReady) {
    availableActions.add("search_knowledge");
    catalogIdentities.push({ name: "search_knowledge", source: "built-in voice tools" });
  }
  for (const tool of toolRows) {
    availableActions.add(tool.slug);
    catalogIdentities.push({ name: tool.slug, source: `generated tool ${tool.id}` });
  }
  for (const tool of extensionManifest) {
    availableActions.add(tool.name);
    catalogIdentities.push({ name: tool.name, source: "source extension" });
  }
  const remoteNames = new Set(externalMcpManifest.flatMap((manifest) =>
    manifest.tools.map((tool) => tool.name)
  ));
  for (const manifest of externalMcpManifest) for (const tool of manifest.tools) {
    availableActions.add(tool.name);
    catalogIdentities.push({ name: tool.name, source: `MCP server ${manifest.id}` });
  }
  assertUniqueToolCatalog(catalogIdentities);
  const consequentialNames = new Set([
    ...consequentialBuiltInVoiceActionNames(),
    ...remoteNames,
    ...toolRows.map((tool) => tool.slug),
    ...extensionManifest
      .filter((tool) => tool.effect !== "read")
      .map((tool) => tool.name),
  ]);
  assertFlowToolCatalogClosure(flow, availableActions, remoteNames, consequentialNames);
  const snapshot = CallRuntimeSnapshotSchema.parse({
    v: 2,
    agentVersion: agent.version,
    namedFlowId: flowId,
    flow,
    instructions: named?.instructions ?? agent.instructions,
    codeRevision: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? "local-development",
    toolManifest: agent.tool_ids.flatMap((id) => {
      const tool = toolsById.get(id);
      return tool ? [{
        id: tool.id,
        slug: tool.slug,
        description: tool.description,
        inputSchema: tool.input_schema,
        endpointUrl: tool.endpoint_url,
        invocationKeyId: tool.invocation_key_id,
      }] : [];
    }),
    extensionManifest,
    externalMcpManifest,
    environment: {
      internetEnabled: org?.internet_enabled ?? false,
      allowedDomains: org?.allowed_domains ?? [],
      docsReady,
      datasetSlugs: datasets.map((dataset) => dataset.slug),
      holdMusic: !!holdMusic,
    },
    // Source-revision time is deterministic across preview/admission rebuilds;
    // wall-clock snapshot time would make identical runtime digests drift.
    createdAt: new Date(agent.created_at).toISOString(),
  });
  return { snapshot, digest: callRuntimeDigest(snapshot) };
}

function deepFreezeSnapshot<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreezeSnapshot(child);
  return Object.freeze(value);
}

/**
 * Read-only admission helper for scheduled/campaign calls. It builds the exact
 * runtime artifact once, without creating or mutating a call row. Launch code
 * must persist this snapshot+digest unchanged instead of rebuilding current
 * agent configuration after operator authorization.
 */
export async function buildVoiceRuntimeSnapshotForAdmission(input: {
  agentId: string;
  orgId: string;
  flowId: string | null;
  admissionScopeId: string;
}): Promise<{
  agentVersion: number;
  snapshot: CallRuntimeSnapshot;
  digest: string;
}> {
  const batch = await buildVoiceRuntimeSnapshotsForAdmissions({
    agentId: input.agentId,
    orgId: input.orgId,
    flowId: input.flowId,
    admissionScopeIds: [input.admissionScopeId],
  });
  const validated = batch.runtimes[0];
  if (!validated) throw new Error("runtime admission did not produce a snapshot");
  return {
    agentVersion: batch.agentVersion,
    snapshot: validated.snapshot,
    digest: validated.digest,
  };
}

export type VoiceRuntimeAdmission = Readonly<{
  admissionScopeId: string;
  snapshot: CallRuntimeSnapshot;
  digest: string;
}>;

/**
 * Builds call-bound snapshots for a canonical set of future call ids while loading shared
 * agent, generated-tool, MCP, and environment state only once. Extension availability is still
 * evaluated independently for every call id; a call cannot inherit another target's catalog.
 */
export async function buildVoiceRuntimeSnapshotsForAdmissions(input: Readonly<{
  agentId: string;
  orgId: string;
  flowId: string | null;
  admissionScopeIds: readonly string[];
}>): Promise<Readonly<{
  agentVersion: number;
  runtimes: readonly VoiceRuntimeAdmission[];
}>> {
  if (
    !UUID_PATTERN.test(input.agentId) || !UUID_PATTERN.test(input.orgId) ||
    (input.flowId !== null && !UUID_PATTERN.test(input.flowId)) ||
    input.admissionScopeIds.length < 1 ||
    input.admissionScopeIds.length > MAX_BATCH_RUNTIME_ADMISSIONS ||
    input.admissionScopeIds.some((id) => !UUID_PATTERN.test(id)) ||
    new Set(input.admissionScopeIds).size !== input.admissionScopeIds.length
  ) throw new Error("runtime admission identifiers must be unique UUIDs within the batch limit");
  const agent = await loadActiveAgent(input.agentId, input.orgId);
  if (!agent) throw new Error("agent not found for runtime admission");

  const firstId = input.admissionScopeIds[0]!;
  const firstCandidate = await buildRuntimeSnapshot(agent, firstId, input.flowId);
  const first = parseCallRuntimeSnapshot(firstCandidate.snapshot, firstCandidate.digest);
  const runtimes: VoiceRuntimeAdmission[] = [Object.freeze({
    admissionScopeId: firstId,
    snapshot: deepFreezeSnapshot(first.snapshot),
    digest: first.digest,
  })];

  for (let offset = 1; offset < input.admissionScopeIds.length; offset += RUNTIME_ADMISSION_BATCH_CONCURRENCY) {
    const ids = input.admissionScopeIds.slice(offset, offset + RUNTIME_ADMISSION_BATCH_CONCURRENCY);
    const admitted = await Promise.all(ids.map(async (admissionScopeId): Promise<VoiceRuntimeAdmission> => {
      const extensionManifest = await voiceToolExtensions.definitions({
        callId: admissionScopeId,
        agentId: agent.agent_id,
        orgId: agent.org_id,
      });
      const snapshot = CallRuntimeSnapshotSchema.parse({
        ...first.snapshot,
        extensionManifest,
      });
      assertRuntimeSnapshotToolClosure(snapshot);
      const digest = callRuntimeDigest(snapshot);
      return Object.freeze({
        admissionScopeId,
        snapshot: deepFreezeSnapshot(snapshot),
        digest,
      });
    }));
    runtimes.push(...admitted);
  }
  return Object.freeze({
    agentVersion: agent.version,
    runtimes: Object.freeze(runtimes),
  });
}

async function ensureRuntimeSnapshot(
  agent: AgentVersionRow,
  callId: string,
  call: CallRow
): Promise<{ snapshot: CallRuntimeSnapshot; digest: string }> {
  if (call.runtime_snapshot) return parseCallRuntimeSnapshot(call.runtime_snapshot, call.runtime_digest);
  const candidate = await buildRuntimeSnapshot(agent, callId, call.flow_id);
  const updated = await qOne<{ runtime_snapshot: unknown; runtime_digest: string }>(
    `UPDATE calls SET runtime_snapshot = $2, runtime_digest = $3
     WHERE id = $1 AND runtime_snapshot IS NULL
     RETURNING runtime_snapshot, runtime_digest`,
    [callId, JSON.stringify(candidate.snapshot), candidate.digest]
  );
  if (updated) return parseCallRuntimeSnapshot(updated.runtime_snapshot, updated.runtime_digest);
  const winner = await qOne<{ runtime_snapshot: unknown; runtime_digest: string }>(
    "SELECT runtime_snapshot, runtime_digest FROM calls WHERE id = $1",
    [callId]
  );
  if (!winner?.runtime_snapshot) throw new Error("call runtime snapshot could not be pinned");
  return parseCallRuntimeSnapshot(winner.runtime_snapshot, winner.runtime_digest);
}

/** Resolves one provider-neutral session spec for an existing call. */
export function voiceSessionSpecForCall(
  agent: AgentVersionRow,
  callId: string,
  direction: "web",
  origin: string,
  browserFundingAuthority: BrowserProviderFundingAuthority,
): Promise<VoiceSessionSpec>;
export function voiceSessionSpecForCall(
  agent: AgentVersionRow,
  callId: string,
  direction: "inbound" | "outbound",
  origin: string,
): Promise<VoiceSessionSpec>;
export async function voiceSessionSpecForCall(
  agent: AgentVersionRow,
  callId: string,
  direction: "web" | "inbound" | "outbound",
  origin: string,
  browserFundingAuthority?: BrowserProviderFundingAuthority,
): Promise<VoiceSessionSpec> {
  const trustedOrigin = requirePublicOrigin();
  if (origin !== trustedOrigin) throw new Error("voice session origin must match PUBLIC_ORIGIN");
  const call = await qOne<CallRow>(
    `SELECT direction, from_number, to_number, experiment_id, variant, agent_version, flow_id,
            runtime_snapshot, runtime_digest, started_at
     FROM calls WHERE id = $1`,
    [callId]
  );
  if (!call) throw new Error("call not found");
  const [resolvedAgent, callerContext] = await Promise.all([
    resolveVariant(agent, callId, call),
    callerContextBlock(agent.org_id, callId, call),
  ]);
  const pinned = await ensureRuntimeSnapshot(resolvedAgent, callId, call);
  const effective = {
    ...resolvedAgent,
    flow: pinned.snapshot.flow,
    instructions: pinned.snapshot.instructions,
    tool_ids: pinned.snapshot.toolManifest.map((tool) => tool.id),
    mcp_server_ids: pinned.snapshot.externalMcpManifest.map((server) => server.id),
  };

  const toolProxyUrl = `${trustedOrigin}/api/mcp`;
  const provider = resolveVoiceProviderConfig(effective.settings, effective.voice);
  if (direction === "web") {
    assertBrowserVoiceSessionAdmission({
      provider: provider.provider,
      origin: trustedOrigin,
      fundingAuthority: browserFundingAuthority,
    });
  }
  // Dynamic import avoids a voice.ts <-> mcp.ts module-initialization cycle: mcp.ts verifies
  // signed scope tokens from this module, while this late session step needs its pinned catalog.
  const routeAuthority = await (async () => {
    const runtime = await import("./mcp") as unknown as {
      activeConversationRouteAuthorityFor: (identity: {
        callId: string;
        agentId: string;
        orgId: string;
      }) => Promise<{
        authority: { catalog: ActiveCapabilityCatalog };
        flow: {
          runtimeDigest: string;
          state: import("./flow-runtime").FlowExecutionState;
        } | null;
      }>;
    };
    if (typeof runtime.activeConversationRouteAuthorityFor !== "function") {
      throw new Error("active conversation route authority is unavailable");
    }
    return runtime.activeConversationRouteAuthorityFor({
      callId,
      agentId: agent.agent_id,
      orgId: agent.org_id,
    });
  })();
  const callStartedAtMs = new Date(call.started_at).getTime();
  if (!Number.isSafeInteger(callStartedAtMs) || callStartedAtMs < 0) {
    throw new Error("call start timestamp is invalid");
  }
  const liveRoute = await import("./live-conversation-route-postgres");
  const durableRoute = await liveRoute.preparePostgresLiveConversationRoute({
    callId,
    organizationId: agent.org_id,
    agentId: agent.agent_id,
    agentVersion: resolvedAgent.version,
    callStartedAtMs,
    catalog: routeAuthority.authority.catalog,
    flow: routeAuthority.flow,
  });
  const browserRotationRoot = direction === "web"
    ? randomBytes(16).toString("base64url")
    : null;
  const browserIssuedAt = direction === "web" ? Math.floor(Date.now() / 1_000) : null;
  const scope = signScope(
    { callId, agentId: agent.agent_id, orgId: agent.org_id },
    {
      audience: "mcp",
      purpose: "tool-invocation",
      method: "POST",
      provider: provider.provider,
      ttlSeconds: 30 * 60,
      ...(browserRotationRoot && browserIssuedAt !== null
        ? {
            issuedAt: browserIssuedAt,
            jti: deriveRotatedScopedJti(browserRotationRoot, 0, "mcp"),
          }
        : {}),
    }
  );
  const browserRenewalToken = browserRotationRoot && browserIssuedAt !== null
    ? signScope(
        { callId, agentId: agent.agent_id, orgId: agent.org_id },
        {
          audience: "browser_refresh",
          purpose: "capability_rotation",
          method: "POST",
          provider: provider.provider,
          ttlSeconds: 30 * 60,
          issuedAt: browserIssuedAt,
          // Generation zero uses the root itself so the first authenticated
          // rotation can establish durable state without persisting a bearer.
          jti: browserRotationRoot,
        }
      )
    : null;
  const mcpServers: RemoteMcpServer[] = [{
    label: "callcenter",
    serverUrl: toolProxyUrl,
    authorization: `Bearer ${scope}`,
  }];
  if (pinned.snapshot.externalMcpManifest.some((manifest) => !isPinnedExternalMcpManifest(manifest))) {
    throw new Error("legacy provider-direct MCP snapshots are disabled; reconnect the server and restart the call");
  }

  const humanNumber = call.direction === "outbound" ? call.to_number : call.from_number;
  const callFacts = humanNumber
    ? `CALL FACTS: the number on this call is ${humanNumber} — use it whenever a step needs the caller's phone number; never ask them for it.\n\n`
    : "";
  return {
    ...provider,
    instructions:
      `${callFacts}${callerContext}${effective.instructions}\n\nYou are on a live ${direction} call. Keep responses short and natural for voice. ` +
      `Treat only the current active capability catalog as tool authority; never guess an unavailable action.\n\n` +
      `${durableContextPacketInstructions(durableRoute.packet)}\n\n` +
      activeCapabilityCatalogInstructions(routeAuthority.authority.catalog),
    mcpServers,
    toolProxyUrl,
    toolProxyToken: scope,
    ...(browserRenewalToken && browserIssuedAt !== null
      ? {
          toolProxyRotation: {
            endpoint: "/api/voice/capabilities/rotate" as const,
            callId,
            rotation: 0,
            renewalToken: browserRenewalToken,
            refreshAfter: new Date((browserIssuedAt + 25 * 60) * 1_000).toISOString(),
            expiresAt: new Date((browserIssuedAt + 30 * 60) * 1_000).toISOString(),
          },
        }
      : {}),
    activeCatalogAuthority: {
      catalogDigest: routeAuthority.authority.catalog.catalog_digest,
      capabilityEpoch: routeAuthority.authority.catalog.capability_epoch,
      runtimeDigest: routeAuthority.authority.catalog.runtime_digest,
      stateRevision: routeAuthority.authority.catalog.state_revision,
    },
  };
}

/** Provider-specific event used by server bridges. Audio "pcmu" is Twilio's native 8kHz μ-law. */
export async function sessionUpdateForCall(
  agent: AgentVersionRow,
  callId: string,
  direction: "web" | "inbound" | "outbound",
  origin: string,
  audio: RealtimeAudioFormat = "pcm",
  browserFundingAuthority?: BrowserProviderFundingAuthority,
): Promise<Record<string, unknown>> {
  const spec = direction === "web"
    ? await voiceSessionSpecForCall(
        agent,
        callId,
        "web",
        origin,
        browserFundingAuthority as BrowserProviderFundingAuthority,
      )
    : await voiceSessionSpecForCall(agent, callId, direction, origin);
  return buildProviderSessionUpdate(
    spec,
    audio
  );
}

/** Creates the call row (experiment variant + optional named flow stamped at insert) and the session.update payload. */
export function buildVoiceSession(
  agent: AgentVersionRow,
  direction: "web",
  origin: string,
  numbers: { from?: string; to?: string },
  opts: {
    flowId?: string | null;
    browserFundingAuthority: BrowserProviderFundingAuthority;
  },
): Promise<{
  callId: string;
  sessionSpec: VoiceSessionSpec;
  sessionUpdate: Record<string, unknown>;
}>;
export function buildVoiceSession(
  agent: AgentVersionRow,
  direction: "inbound" | "outbound",
  origin: string,
  numbers?: { from?: string; to?: string },
  opts?: { flowId?: string | null },
): Promise<{
  callId: string;
  sessionSpec: VoiceSessionSpec;
  sessionUpdate: Record<string, unknown>;
}>;
export async function buildVoiceSession(
  agent: AgentVersionRow,
  direction: "web" | "inbound" | "outbound",
  origin: string,
  numbers: { from?: string; to?: string } = {},
  opts: {
    flowId?: string | null;
    browserFundingAuthority?: BrowserProviderFundingAuthority;
  } = {}
): Promise<{ callId: string; sessionSpec: VoiceSessionSpec; sessionUpdate: Record<string, unknown> }> {
  const pick = await pickVariant(agent.agent_id).catch(() => null);
  const call = await qOne<{ id: string }>(
    `INSERT INTO calls (agent_id, agent_version, direction, from_number, to_number, experiment_id, variant, flow_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      agent.agent_id, pick?.agentVersion ?? agent.version, direction,
      numbers.from ?? null, numbers.to ?? null, pick?.experimentId ?? null, pick?.variant ?? null,
      opts.flowId ?? null,
    ]
  );
  const callId = call!.id;
  try {
    const sessionSpec = direction === "web"
      ? await voiceSessionSpecForCall(
          agent,
          callId,
          "web",
          origin,
          opts.browserFundingAuthority as BrowserProviderFundingAuthority,
        )
      : await voiceSessionSpecForCall(agent, callId, direction, origin);
    const sessionUpdate = buildProviderSessionUpdate(sessionSpec, "pcm");
    return { callId, sessionSpec, sessionUpdate };
  } catch (error) {
    await q(
      "UPDATE calls SET status = 'failed', ended_at = now() WHERE id = $1 AND status = 'active'",
      [callId]
    ).catch(() => {});
    throw error;
  }
}
