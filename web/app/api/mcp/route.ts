// Author: Harsha Gundala
// mcp — MCP gateway endpoint (streamable HTTP, JSON-RPC 2.0) consumed server-side by xAI voice sessions.

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { NextResponse } from "next/server";
import { verifyScope, type ScopeClaims } from "@/lib/voice";
import {
  activeConversationRouteAuthorityFor,
  callActiveCapability,
} from "@/lib/mcp";
import {
  blockedActiveCapabilityCatalog,
  blockedActiveCapabilityCatalogFromExpectation,
  buildActiveCapabilityGatewayEnvelope,
  type ActiveCapabilityCatalog,
  type ActiveCatalogExpectation,
} from "@/lib/active-capability-catalog";
import { qOne } from "@/lib/db";
import { PrivateRequestError, readStrictJsonObject } from "@/lib/private-json-request";
import { resolveVoiceProviderConfig } from "@/lib/realtime/config";
import { log } from "@/lib/log";
import {
  MCP_LATEST_PROTOCOL_VERSION,
  MCP_MAX_PROVIDER_TOOL_CALL_ID_BYTES,
  MCP_PROVIDER_TOOL_CALL_ID_META_KEY,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
} from "@/lib/mcp-client";
import { MCP_MAX_PERSISTED_MODEL_ARGUMENT_BYTES } from "@/lib/mcp-invocation-store";
import { mcpGatewaySecret } from "@/lib/high-authority-secrets";

export const maxDuration = 60;
const L = log("mcp");

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RPC_ID_BYTES = 256;
const MCP_SESSION_DOMAIN = "harshas-amazing-call-center/mcp-session/v1\n";
const PROVIDER_INVOCATION_DOMAIN = "harshas-amazing-call-center/provider-tool-call/v1\n";
const ACTIVE_CATALOG_META_KEY = "com.harsha.callcenter/active-catalog";
const MCP_SESSION_ID_PATTERN = /^hacc\.v1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

type RpcId = number | string | null;
type RpcRequest = { jsonrpc: "2.0"; id?: RpcId; method: string; params?: Record<string, unknown> };

function responseHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  return headers;
}

function rpcResult(id: RpcRequest["id"], result: unknown, headers?: HeadersInit) {
  return NextResponse.json(
    { jsonrpc: "2.0", id: id ?? null, result },
    { headers: responseHeaders(headers) }
  );
}

function rpcError(
  id: RpcRequest["id"],
  code: number,
  message: string,
  status = 200
) {
  return NextResponse.json(
    { jsonrpc: "2.0", id: id ?? null, error: { code, message } },
    { status, headers: responseHeaders() }
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validRpcId(value: unknown): value is Exclude<RpcId, null> {
  if (typeof value === "number") return Number.isSafeInteger(value);
  return typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_RPC_ID_BYTES &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function sessionSecret(): string {
  return mcpGatewaySecret();
}

function sessionAuthenticator(scope: ScopeClaims, nonce: string): Buffer {
  return createHmac("sha256", sessionSecret())
    .update(MCP_SESSION_DOMAIN, "utf8")
    .update(JSON.stringify([
      scope.aud,
      scope.orgId,
      scope.callId,
      scope.provider,
      scope.jti,
      scope.providerCallId ?? null,
      scope.providerAccountId ?? null,
      scope.providerTo ?? null,
      scope.providerStreamId ?? null,
      scope.transportProvider ?? null,
      nonce,
    ]), "utf8")
    .digest();
}

function mintMcpSessionId(scope: ScopeClaims): string {
  const nonce = randomBytes(16).toString("base64url");
  return `hacc.v1.${nonce}.${sessionAuthenticator(scope, nonce).toString("base64url")}`;
}

function validMcpSessionId(value: string | null, scope: ScopeClaims): boolean {
  const match = value?.match(MCP_SESSION_ID_PATTERN);
  if (!match) return false;
  const [, nonce, suppliedTag] = match;
  const nonceBytes = Buffer.from(nonce, "base64url");
  const supplied = Buffer.from(suppliedTag, "base64url");
  if (
    nonceBytes.byteLength !== 16 ||
    nonceBytes.toString("base64url") !== nonce ||
    supplied.byteLength !== 32 ||
    supplied.toString("base64url") !== suppliedTag
  ) {
    return false;
  }
  return timingSafeEqual(supplied, sessionAuthenticator(scope, nonce));
}

function persistentProviderToolCallId(params: Record<string, unknown> | undefined): string | null {
  const metadata = params?._meta;
  if (!isRecord(metadata) ||
      !Object.prototype.hasOwnProperty.call(metadata, MCP_PROVIDER_TOOL_CALL_ID_META_KEY)) {
    return null;
  }
  const value = metadata[MCP_PROVIDER_TOOL_CALL_ID_META_KEY];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MCP_MAX_PROVIDER_TOOL_CALL_ID_BYTES ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return null;
  }
  return value;
}

function activeCatalogExpectation(
  params: Record<string, unknown> | undefined
): ActiveCatalogExpectation | null {
  const metadata = params?._meta;
  if (!isRecord(metadata) ||
      !Object.prototype.hasOwnProperty.call(metadata, ACTIVE_CATALOG_META_KEY)) {
    return null;
  }
  const value = metadata[ACTIVE_CATALOG_META_KEY];
  if (!isRecord(value) ||
      Object.keys(value).length !== 2 ||
      !Object.prototype.hasOwnProperty.call(value, "catalog_digest") ||
      !Object.prototype.hasOwnProperty.call(value, "capability_epoch") ||
      typeof value.catalog_digest !== "string" ||
      !SHA256_PATTERN.test(value.catalog_digest) ||
      !Number.isSafeInteger(value.capability_epoch) ||
      (value.capability_epoch as number) < 0 ||
      (value.capability_epoch as number) > 2_147_483_647) {
    return null;
  }
  return Object.freeze({
    catalog_digest: value.catalog_digest,
    capability_epoch: value.capability_epoch as number,
  });
}

function providerInvocationId(scope: ScopeClaims, persistentProviderId: string): string {
  const digest = createHash("sha256")
    .update(PROVIDER_INVOCATION_DOMAIN, "utf8")
    .update(JSON.stringify([
      scope.orgId,
      scope.callId,
      scope.provider,
      persistentProviderId,
    ]), "utf8")
    .digest("hex");
  return `mcp-provider:v1:${digest}`;
}

export async function POST(req: Request) {
  const contentType = req.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return rpcError(null, -32600, "Content-Type must be application/json", 415);
  }
  const authorization = req.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer ([^\s,]+)$/);
  const directScope = match && authorization.length <= 4_096
    ? verifyScope(match[1], {
        audience: "mcp",
        purpose: "tool-invocation",
        method: "POST",
        provider: ["xai", "openai", "gemini"],
      })
    : null;
  const bridgeScope = !directScope && match && authorization.length <= 4_096
    ? verifyScope(match[1], {
        audience: "bridge_mcp",
        purpose: "tool_invocation",
        method: "POST",
        provider: ["xai", "openai", "gemini"],
        transportProvider: "twilio",
      })
    : null;
  const scope = directScope ?? bridgeScope;
  if (!scope) return rpcError(null, -32001, "invalid scope", 401);

  let candidate: unknown;
  try {
    candidate = await readStrictJsonObject(req, MAX_REQUEST_BYTES);
  } catch (error) {
    const requestTooLarge = error instanceof PrivateRequestError && error.status === 413;
    return rpcError(
      null,
      -32700,
      requestTooLarge ? "request too large" : "parse error",
      requestTooLarge ? 413 : 400
    );
  }
  if (!isRecord(candidate) || candidate.jsonrpc !== "2.0" ||
      typeof candidate.method !== "string" || candidate.method.length < 1 ||
      candidate.method.length > 128 || /[\u0000-\u001f\u007f]/.test(candidate.method) ||
      (candidate.params !== undefined && !isRecord(candidate.params)) ||
      (candidate.id !== undefined && candidate.id !== null && !validRpcId(candidate.id))) {
    return rpcError(null, -32600, "invalid request", 400);
  }
  const rpc = candidate as RpcRequest;

  // The signed provider claim is checked against the provider pinned to this
  // still-live call. This lookup intentionally happens only after the body is
  // capped and structurally valid, so malformed authenticated traffic cannot
  // amplify into database work.
  const providerBinding = scope.aud === "bridge_mcp"
    ? await qOne<{
        settings: Record<string, unknown>;
        voice: string;
        agent_version: number;
        started_at: Date | string;
      }>(
        `SELECT v.settings, v.voice, c.agent_version, c.started_at FROM calls c
         JOIN agents a ON a.id = c.agent_id
         JOIN agent_versions v ON v.agent_id = c.agent_id AND v.version = c.agent_version
         JOIN telephony_stream_bindings b ON b.call_id = c.id
         WHERE c.id = $1 AND c.agent_id = $2 AND a.org_id = $3
           AND c.status = 'active'
           AND c.twilio_call_sid = $4 AND c.twilio_account_sid = $5 AND c.to_number = $6
           AND b.stream_sid = $7 AND b.provider = 'twilio'
           AND b.provider_call_sid = $4 AND b.provider_account_sid = $5 AND b.to_number = $6
           AND b.mode = 'agent' AND b.stopped_at IS NULL`,
        [
          scope.callId,
          scope.agentId,
          scope.orgId,
          scope.providerCallId,
          scope.providerAccountId,
          scope.providerTo,
          scope.providerStreamId,
        ]
      )
    : await qOne<{
        settings: Record<string, unknown>;
        voice: string;
        agent_version: number;
        started_at: Date | string;
      }>(
        `SELECT v.settings, v.voice, c.agent_version, c.started_at FROM calls c
         JOIN agents a ON a.id = c.agent_id
         JOIN agent_versions v ON v.agent_id = c.agent_id AND v.version = c.agent_version
         WHERE c.id = $1 AND c.agent_id = $2 AND a.org_id = $3
           AND c.status = 'active'`,
        [scope.callId, scope.agentId, scope.orgId]
      );
  if (
    !providerBinding ||
    resolveVoiceProviderConfig(providerBinding.settings, providerBinding.voice).provider !== scope.provider
  ) return rpcError(null, -32001, "scope provider binding mismatch", 401);

  // Streamable HTTP sessions are server-issued and bound to the authenticated
  // call/provider token. The session authenticates transport continuity only;
  // it deliberately does not participate in durable action identity, so a
  // provider replay after reconnect still resolves to the original receipt.
  if (rpc.method !== "initialize" &&
      !validMcpSessionId(req.headers.get("mcp-session-id"), scope)) {
    return rpcError(rpc.id, -32002, "invalid MCP session", 404);
  }

  switch (rpc.method) {
    case "initialize": {
      if (!validRpcId(rpc.id)) return rpcError(null, -32600, "initialize requires a bounded request id", 400);
      const requested = rpc.params?.protocolVersion;
      const protocolVersion = typeof requested === "string" &&
        (MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : MCP_LATEST_PROTOCOL_VERSION;
      return rpcResult(
        rpc.id,
        {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "callcenter-gateway", version: "1.0.0" },
        },
        { "MCP-Session-Id": mintMcpSessionId(scope) }
      );
    }
    case "notifications/initialized":
      if (rpc.id !== undefined) return rpcError(rpc.id, -32600, "initialized notification must not have an id", 400);
      return new Response(null, { status: 202, headers: SECURITY_HEADERS });
    case "ping":
      if (!validRpcId(rpc.id)) return rpcError(null, -32600, "ping requires a bounded request id", 400);
      return rpcResult(rpc.id, {});
    case "tools/list":
      if (!validRpcId(rpc.id)) return rpcError(null, -32600, "tools/list requires a bounded request id", 400);
      // The provider/bridge boundary installs the single native capability_gateway.
      // Logical active tools are deliberately not advertised through standard MCP:
      // callers lacking captured host metadata cannot safely invoke them.
      return rpcResult(rpc.id, { tools: [] });
    case "tools/call": {
      if (!validRpcId(rpc.id)) {
        return rpcError(null, -32600, "tools/call requires a bounded request id", 400);
      }
      const name = rpc.params?.name;
      const args = rpc.params?.arguments;
      if (typeof name !== "string" || !/^[a-z][a-z0-9_.-]{1,63}$/.test(name) || !isRecord(args)) {
        return rpcError(rpc.id, -32602, "invalid tools/call params", 400);
      }
      if (
        Buffer.byteLength(JSON.stringify(args), "utf8") >
        MCP_MAX_PERSISTED_MODEL_ARGUMENT_BYTES
      ) {
        return rpcError(rpc.id, -32602, "tool arguments exceed the durable replay limit", 413);
      }
      const providerToolCallId = persistentProviderToolCallId(rpc.params);
      if (!providerToolCallId) {
        return rpcError(
          rpc.id,
          -32602,
          `tools/call requires params._meta[${JSON.stringify(MCP_PROVIDER_TOOL_CALL_ID_META_KEY)}]`,
          400
        );
      }
      const expectedCatalog = activeCatalogExpectation(rpc.params);
      if (!expectedCatalog) {
        return rpcError(
          rpc.id,
          -32602,
          `tools/call requires exact params._meta[${JSON.stringify(ACTIVE_CATALOG_META_KEY)}] authority`,
          400
        );
      }
      // Only client-owned top-level params._meta supplies provider identity.
      // arguments._meta remains ordinary, untrusted model input. Catalog
      // authority is host-owned, and JSON-RPC ids correlate transport
      // responses without ever determining durable receipts.
      const outcome = await callActiveCapability(scope, name, args, {
        invocationId: providerInvocationId(scope, providerToolCallId),
        expectedCatalog,
      });
      let currentCatalog: ActiveCapabilityCatalog;
      let routeAuthority: Awaited<ReturnType<typeof activeConversationRouteAuthorityFor>> | null = null;
      let realtimeContextPacket: unknown | null = null;
      try {
        routeAuthority = await activeConversationRouteAuthorityFor(scope);
        currentCatalog = routeAuthority.authority.catalog;
      } catch (error) {
        L.error("post-action capability catalog refresh failed", {
          orgId: scope.orgId,
          callId: scope.callId,
          kind: error instanceof Error ? error.name : "unknown",
          message: error instanceof Error ? error.message : "non-error rejection",
        });
        // The action result is already durable at this point. Preserve it while
        // stripping all subsequent authority until a clean reconnect can load
        // the authoritative post-action state. This synthetic blocked catalog
        // is derived only from the captured expectation, so terminal receipt
        // replay never consults mutable current authority before admission.
        currentCatalog = blockedActiveCapabilityCatalogFromExpectation(
          expectedCatalog,
          "catalog_refresh_failed"
        );
      }
      if (routeAuthority) {
        try {
          const callStartedAtMs = new Date(providerBinding.started_at).getTime();
          if (!Number.isSafeInteger(callStartedAtMs) || callStartedAtMs < 0) {
            throw new Error("call start timestamp is invalid");
          }
          const { preparePostgresLiveConversationRoute } =
            await import("@/lib/live-conversation-route-postgres");
          const prepared = await preparePostgresLiveConversationRoute({
            callId: scope.callId,
            organizationId: scope.orgId,
            agentId: scope.agentId,
            agentVersion: providerBinding.agent_version,
            callStartedAtMs,
            catalog: currentCatalog,
            flow: routeAuthority.flow,
          });
          realtimeContextPacket = prepared.packet.value;
        } catch (error) {
          L.error("post-action durable context packet refresh failed", {
            orgId: scope.orgId,
            callId: scope.callId,
            kind: error instanceof Error ? error.name : "unknown",
            message: error instanceof Error ? error.message : "non-error rejection",
          });
          // Catalog recovery and durable-context projection are separate
          // authority domains. Keep the exact post-action epoch/revision but
          // remove every callable tool until reconnect; never regress to the
          // pre-action expectation merely because packet refresh failed.
          currentCatalog = blockedActiveCapabilityCatalog(
            currentCatalog,
            "context_packet_refresh_failed"
          );
        }
      }
      const contextualOutcome = realtimeContextPacket === null
        ? outcome
        : isRecord(outcome)
          ? { ...outcome, hacc_realtime_context_packet: realtimeContextPacket }
          : { value: outcome, hacc_realtime_context_packet: realtimeContextPacket };
      const envelope = buildActiveCapabilityGatewayEnvelope(contextualOutcome, currentCatalog);
      const isErr = isRecord(envelope.outcome) && "error" in envelope.outcome;
      return rpcResult(rpc.id, {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        isError: isErr,
      });
    }
    default:
      return rpcError(rpc.id, -32601, "method not found");
  }
}
