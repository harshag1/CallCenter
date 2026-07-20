// Author: Harsha Gundala
// telephony/session — exchanges a one-use TwiML bootstrap capability for a bound bridge session.

import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { ensureSafeDatabaseRuntimeRole, getPool, qOne } from "@/lib/db";
import {
  deriveScopedJti,
  loadActiveAgent,
  verifyScope,
  voiceSessionSpecForCall,
  type ScopeClaims,
} from "@/lib/voice";
import {
  CAPABILITY_ROTATION_OVERLAP_SECONDS,
  CAPABILITY_ROTATION_TTL_SECONDS,
  issueBridgeCapabilityRotation,
} from "@/lib/capability-rotation";
import { PrivateRequestError, readStrictJsonObject } from "@/lib/private-json-request";
import { buildProviderSessionUpdate, serverRealtimeEndpoint } from "@/lib/realtime/registry";
import type { VoiceSessionSpec } from "@/lib/realtime/types";
import { requireBridgeWsUrl, requirePublicOrigin } from "@/lib/telephony";

const MAX_BODY_BYTES = 64 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;
const CALL_SID = /^CA[0-9a-fA-F]{32}$/;
const STREAM_SID = /^MZ[0-9a-fA-F]{32}$/;
const MCP_TOKEN_PLACEHOLDER = "__HACC_BRIDGE_MCP_CAPABILITY_V1__";

type Connection = {
  account_sid: string;
  call_sid: string;
  stream_sid: string;
  mode: "agent";
};

type ExchangeBody = {
  schema_version: 3;
  session_id: string;
  bridge_instance_id: string;
  connection: Connection;
};

type StoredConfig = {
  provider: "xai" | "openai";
  model: string;
  ws_url: string;
  session_update: Record<string, unknown>;
  active_catalog_authority: {
    catalog_digest: string;
    capability_epoch: number;
  };
};

type ExistingBinding = {
  jti: string;
  audience: string;
  call_id: string;
  stream_sid: string;
  session_id: string | null;
  bridge_instance_id: string | null;
  binding_bootstrap_jti: string | null;
  provider_account_sid: string;
  provider_call_sid: string;
  to_number: string;
  mode: string;
  bootstrap_session_config: string | null;
  rotation_root_jti: string | null;
  rotation_generation: string | number | null;
  rotation_issued_at: string | number | null;
  rotation_provider: string | null;
};

type BoundSession = Readonly<{
  config: string;
  rotationRootJti: string;
  generation: number;
  issuedAt: number;
  provider: "xai" | "openai";
}>;

function json(body: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function bearer(req: Request): string | null {
  const authorization = req.headers.get("authorization") ?? "";
  if (authorization.length > 4_096) return null;
  return authorization.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/)?.[1] ?? null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function parseBody(value: unknown): ExchangeBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (!exactKeys(body, ["schema_version", "session_id", "bridge_instance_id", "connection"])) return null;
  if (
    body.schema_version !== 3 ||
    typeof body.session_id !== "string" || !SAFE_ID.test(body.session_id) ||
    typeof body.bridge_instance_id !== "string" || !SAFE_ID.test(body.bridge_instance_id) ||
    !body.connection || typeof body.connection !== "object" || Array.isArray(body.connection)
  ) return null;
  const connection = body.connection as Record<string, unknown>;
  if (!exactKeys(connection, ["account_sid", "call_sid", "stream_sid", "mode"])) return null;
  if (
    typeof connection.account_sid !== "string" || !ACCOUNT_SID.test(connection.account_sid) ||
    typeof connection.call_sid !== "string" || !CALL_SID.test(connection.call_sid) ||
    typeof connection.stream_sid !== "string" || !STREAM_SID.test(connection.stream_sid) ||
    connection.mode !== "agent"
  ) return null;
  return {
    schema_version: 3,
    session_id: body.session_id,
    bridge_instance_id: body.bridge_instance_id,
    connection: {
      account_sid: connection.account_sid,
      call_sid: connection.call_sid,
      stream_sid: connection.stream_sid,
      mode: "agent",
    },
  } as ExchangeBody;
}

function bridgeOriginSha256(): string {
  return createHash("sha256").update(requireBridgeWsUrl(), "utf8").digest("hex");
}

function withDeterministicMcpCapability(spec: VoiceSessionSpec, token: string): VoiceSessionSpec {
  return {
    ...spec,
    // Standalone bridges execute only the local capability_gateway function.
    // A call-level experimental provider-direct preference must never move a
    // remote MCP URL or bearer into the provider session for this transport.
    settings: {
      ...spec.settings,
      experimental_provider_direct_mcp: {
        enabled: false,
        allow_consequential: false,
      },
    },
    toolProxyToken: token,
    mcpServers: spec.mcpServers.map((server) => ({
      ...server,
      authorization: `Bearer ${token}`,
    })),
  };
}

function mcpTools(config: StoredConfig): Array<Record<string, unknown>> {
  const update = config.session_update;
  const session = update.session;
  if (!session || typeof session !== "object" || Array.isArray(session)) return [];
  const tools = (session as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) return [];
  return tools.filter((tool): tool is Record<string, unknown> => (
    !!tool && typeof tool === "object" && !Array.isArray(tool)
      && (tool as Record<string, unknown>).type === "mcp"
  ));
}

function storedConfig(config: StoredConfig, mcpToken: string): string {
  const scrubbed = JSON.parse(JSON.stringify(config)) as StoredConfig;
  for (const tool of mcpTools(scrubbed)) {
    if (tool.authorization === `Bearer ${mcpToken}`) {
      tool.authorization = `Bearer ${MCP_TOKEN_PLACEHOLDER}`;
    }
  }
  const serialized = JSON.stringify(scrubbed);
  if (serialized.includes(mcpToken) || Buffer.byteLength(serialized, "utf8") > 1024 * 1024) {
    throw new Error("bridge session configuration is unsafe to persist");
  }
  return serialized;
}

function restoredConfig(serialized: string, mcpToken: string): StoredConfig {
  if (Buffer.byteLength(serialized, "utf8") > 1024 * 1024) throw new Error("stored bridge configuration is too large");
  const value = JSON.parse(serialized) as Partial<StoredConfig>;
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    !exactKeys(value as Record<string, unknown>, [
      "provider", "model", "ws_url", "session_update", "active_catalog_authority",
    ]) ||
    (value.provider !== "xai" && value.provider !== "openai") ||
    typeof value.model !== "string" || !value.model || value.model.length > 256 ||
    typeof value.ws_url !== "string" || !value.ws_url.startsWith("wss://") || value.ws_url.length > 2_048 ||
    !value.session_update || typeof value.session_update !== "object" || Array.isArray(value.session_update) ||
    !value.active_catalog_authority ||
    typeof value.active_catalog_authority !== "object" ||
    Array.isArray(value.active_catalog_authority) ||
    !exactKeys(value.active_catalog_authority as Record<string, unknown>, [
      "catalog_digest", "capability_epoch",
    ]) ||
    typeof value.active_catalog_authority.catalog_digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.active_catalog_authority.catalog_digest) ||
    !Number.isSafeInteger(value.active_catalog_authority.capability_epoch) ||
    Number(value.active_catalog_authority.capability_epoch) < 0
  ) throw new Error("stored bridge configuration is invalid");
  const config = value as StoredConfig;
  for (const tool of mcpTools(config)) {
    if (tool.authorization === `Bearer ${MCP_TOKEN_PLACEHOLDER}`) {
      tool.authorization = `Bearer ${mcpToken}`;
    }
  }
  return config;
}

function exactRetry(
  row: ExistingBinding,
  scope: ScopeClaims,
  body: ExchangeBody
): boolean {
  return row.jti === scope.jti
    && row.audience === "bridge_bootstrap"
    && row.call_id === scope.callId
    && row.stream_sid === body.connection.stream_sid
    && row.session_id === body.session_id
    && row.bridge_instance_id === body.bridge_instance_id
    && row.binding_bootstrap_jti === scope.jti
    && row.provider_account_sid === body.connection.account_sid
    && row.provider_call_sid === body.connection.call_sid
    && row.to_number === scope.providerTo
    && row.mode === body.connection.mode
    && typeof row.bootstrap_session_config === "string"
    && typeof row.rotation_root_jti === "string"
    && row.rotation_generation !== null
    && row.rotation_issued_at !== null;
}

async function bindSession(
  scope: ScopeClaims,
  body: ExchangeBody,
  candidateConfig: string,
  provider: "xai" | "openai",
  rotationRootJti: string,
  issuedAt: number,
): Promise<BoundSession | null> {
  await ensureSafeDatabaseRuntimeRole();
  const client = await getPool().connect();
  try {
    // The call-row lock serializes all exchanges for this call. READ COMMITTED
    // deliberately gives a waiting exact retry a fresh snapshot after the
    // winner commits, so it can return the winner's byte-stable configuration
    // instead of surfacing a serialization failure.
    await client.query("BEGIN");
    const call = await client.query<{ id: string }>(
      `SELECT c.id
       FROM calls c JOIN agents a ON a.id = c.agent_id
       WHERE c.id = $1 AND c.agent_id = $2 AND a.org_id = $3
         AND c.twilio_call_sid = $4 AND c.twilio_account_sid = $5 AND c.to_number = $6
         AND c.status = 'active'
       FOR UPDATE OF c`,
      [
        scope.callId,
        scope.agentId,
        scope.orgId,
        body.connection.call_sid,
        body.connection.account_sid,
        scope.providerTo,
      ]
    );
    if (call.rowCount !== 1) {
      await client.query("ROLLBACK");
      return null;
    }

    const conflicts = await client.query<ExistingBinding>(
      `SELECT consumption.jti, consumption.audience, consumption.call_id,
              consumption.stream_sid, consumption.session_id, consumption.bridge_instance_id,
              binding.bootstrap_jti AS binding_bootstrap_jti,
              binding.provider_account_sid, binding.provider_call_sid, binding.to_number,
              binding.mode, binding.bootstrap_session_config,
              rotation.rotation_root_jti,
              rotation.generation AS rotation_generation,
              rotation.issued_at AS rotation_issued_at,
              rotation.provider AS rotation_provider
       FROM telephony_capability_consumptions consumption
       JOIN telephony_stream_bindings binding ON binding.stream_sid = consumption.stream_sid
       LEFT JOIN voice_capability_rotations rotation
         ON rotation.transport = 'telephony'
        AND rotation.call_id = binding.call_id
        AND rotation.session_id = binding.session_id
       WHERE consumption.jti = $1 OR binding.bootstrap_jti = $1
          OR binding.stream_sid = $2 OR binding.session_id = $3
       FOR UPDATE OF consumption, binding`,
      [scope.jti, body.connection.stream_sid, body.session_id]
    );
    if (conflicts.rowCount) {
      const exact = conflicts.rowCount === 1 && exactRetry(conflicts.rows[0], scope, body);
      await client.query(exact ? "COMMIT" : "ROLLBACK");
      if (!exact) return null;
      const existing = conflicts.rows[0];
      const existingGeneration = Number(existing.rotation_generation);
      const existingIssuedAt = Number(existing.rotation_issued_at);
      const existingProvider = existing.rotation_provider;
      if (
        !Number.isSafeInteger(existingGeneration) || existingGeneration < 0
        || !Number.isSafeInteger(existingIssuedAt) || existingIssuedAt < 0
        || (existingProvider !== "xai" && existingProvider !== "openai")
      ) return null;
      return {
        config: existing.bootstrap_session_config!,
        rotationRootJti: existing.rotation_root_jti!,
        generation: existingGeneration,
        issuedAt: existingIssuedAt,
        provider: existingProvider,
      };
    }

    const binding = await client.query(
      `INSERT INTO telephony_stream_bindings (
         stream_sid, call_id, provider, provider_account_sid, provider_call_sid,
         to_number, mode, session_id, bridge_instance_id, bootstrap_jti,
         bootstrap_session_config
       ) VALUES ($1,$2,'twilio',$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        body.connection.stream_sid,
        scope.callId,
        body.connection.account_sid,
        body.connection.call_sid,
        scope.providerTo,
        body.connection.mode,
        body.session_id,
        body.bridge_instance_id,
        scope.jti,
        candidateConfig,
      ]
    );
    if (binding.rowCount !== 1) throw new Error("bridge stream binding failed");
    const consumption = await client.query(
      `INSERT INTO telephony_capability_consumptions (
         jti, audience, call_id, stream_sid, session_id, bridge_instance_id, expires_at
       ) VALUES ($1,'bridge_bootstrap',$2,$3,$4,$5,to_timestamp($6))`,
      [scope.jti, scope.callId, body.connection.stream_sid, body.session_id, body.bridge_instance_id, scope.exp]
    );
    if (consumption.rowCount !== 1) throw new Error("bridge capability consumption failed");
    const rotation = await client.query(
      `INSERT INTO voice_capability_rotations (
         transport, call_id, session_id, bridge_instance_id, stream_sid, provider,
         rotation_root_jti, generation, current_refresh_jti, issued_at, refresh_after, expires_at
       ) VALUES ('telephony',$1,$2,$3,$4,$5,$6,0,$6,$7,to_timestamp($8),to_timestamp($9))`,
      [
        scope.callId,
        body.session_id,
        body.bridge_instance_id,
        body.connection.stream_sid,
        provider,
        rotationRootJti,
        issuedAt,
        issuedAt + CAPABILITY_ROTATION_TTL_SECONDS - CAPABILITY_ROTATION_OVERLAP_SECONDS,
        issuedAt + CAPABILITY_ROTATION_TTL_SECONDS,
      ]
    );
    if (rotation.rowCount !== 1) throw new Error("bridge rotation lease failed");
    await client.query("COMMIT");
    return {
      config: candidateConfig,
      rotationRootJti,
      generation: 0,
      issuedAt,
      provider,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function POST(req: Request) {
  const token = bearer(req);
  if (!token) return json({ error: "invalid capability" }, 401);
  let body: ExchangeBody | null;
  try {
    body = parseBody(await readStrictJsonObject(req, MAX_BODY_BYTES));
  } catch (error) {
    const status = error instanceof PrivateRequestError ? error.status : 400;
    const label = status === 413
      ? "request too large"
      : status === 415
        ? "unsupported media type"
        : "invalid request";
    return json({ error: label }, status);
  }
  if (!body) return json({ error: "invalid request" }, 400);
  if (req.headers.get("idempotency-key") !== body.session_id) {
    return json({ error: "idempotency binding mismatch" }, 400);
  }

  const scope = verifyScope(token, {
    audience: "bridge_bootstrap",
    purpose: "telephony_stream_exchange",
    method: "POST",
    provider: "twilio",
    providerCallId: body.connection.call_sid,
    providerAccountId: body.connection.account_sid,
    bridgeOriginSha256: bridgeOriginSha256(),
  });
  if (!scope?.providerTo) return json({ error: "invalid capability" }, 401);

  const call = await qOne<{
    direction: "inbound" | "outbound";
    metadata: { reason?: unknown };
  }>(
    `SELECT c.direction, c.metadata
     FROM calls c JOIN agents a ON a.id = c.agent_id
     WHERE c.id = $1 AND c.agent_id = $2 AND a.org_id = $3
       AND c.twilio_call_sid = $4 AND c.twilio_account_sid = $5 AND c.to_number = $6
       AND c.status = 'active'`,
    [scope.callId, scope.agentId, scope.orgId, body.connection.call_sid, body.connection.account_sid, scope.providerTo]
  );
  const agent = call ? await loadActiveAgent(scope.agentId, scope.orgId) : null;
  if (!call || !agent) return json({ error: "call not found" }, 404);

  try {
    const spec = await voiceSessionSpecForCall(agent, scope.callId, call.direction, requirePublicOrigin());
    if (call.direction === "outbound" && typeof call.metadata?.reason === "string" && call.metadata.reason.length <= 2_000) {
      spec.instructions += `\n\nYou are placing this outbound call. Purpose: ${call.metadata.reason}. Open by introducing yourself and the reason for the call.`;
    }
    const endpoint = serverRealtimeEndpoint(spec);
    if (endpoint.provider !== "xai" && endpoint.provider !== "openai") {
      return json({ error: "provider unsupported by standalone bridge" }, 409);
    }

    const rotationRootJti = deriveScopedJti(scope.jti, "bridge_refresh");
    const issuedAt = Math.floor(Date.now() / 1_000);
    const initialRotation = issueBridgeCapabilityRotation({
      callId: scope.callId,
      agentId: scope.agentId,
      orgId: scope.orgId,
      provider: endpoint.provider,
      sessionId: body.session_id,
      bridgeInstanceId: body.bridge_instance_id,
      accountSid: body.connection.account_sid,
      callSid: body.connection.call_sid,
      to: scope.providerTo,
      streamSid: body.connection.stream_sid,
    }, rotationRootJti, 0, issuedAt);
    const deterministicSpec = withDeterministicMcpCapability(
      spec,
      initialRotation.mcp_capability.token,
    );
    const candidate = storedConfig({
      provider: endpoint.provider,
      model: deterministicSpec.model,
      ws_url: endpoint.wsUrl,
      session_update: buildProviderSessionUpdate(deterministicSpec, "pcmu"),
      active_catalog_authority: {
        catalog_digest: deterministicSpec.activeCatalogAuthority.catalogDigest,
        capability_epoch: deterministicSpec.activeCatalogAuthority.capabilityEpoch,
      },
    }, initialRotation.mcp_capability.token);
    const selected = await bindSession(
      scope,
      body,
      candidate,
      endpoint.provider,
      rotationRootJti,
      issuedAt,
    );
    if (!selected) return json({ error: "stream identity or capability replay rejected" }, 409);
    const rotation = issueBridgeCapabilityRotation({
      callId: scope.callId,
      agentId: scope.agentId,
      orgId: scope.orgId,
      provider: selected.provider,
      sessionId: body.session_id,
      bridgeInstanceId: body.bridge_instance_id,
      accountSid: body.connection.account_sid,
      callSid: body.connection.call_sid,
      to: scope.providerTo,
      streamSid: body.connection.stream_sid,
    }, selected.rotationRootJti, selected.generation, selected.issuedAt);
    // An exact retry is governed by the first committed provider/configuration,
    // even if mutable agent settings changed while its response was in flight.
    const config = restoredConfig(selected.config, rotation.mcp_capability.token);
    if (config.provider !== selected.provider) throw new Error("stored provider binding changed");

    return json({
      schema_version: 3,
      session_id: body.session_id,
      bridge_instance_id: body.bridge_instance_id,
      call_id: scope.callId,
      connection: body.connection,
      provider: config.provider,
      model: config.model,
      ws_url: config.ws_url,
      session_update: config.session_update,
      active_catalog_authority: config.active_catalog_authority,
      rotation: rotation.rotation,
      rotation_endpoint: "/api/telephony/bridge/capabilities/rotate",
      refresh_after: rotation.refresh_after,
      event_capability: rotation.event_capability,
      mcp_capability: rotation.mcp_capability,
      renewal_capability: rotation.renewal_capability,
      expires_at: rotation.expires_at,
    }, 200);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "23505" || code === "40001") {
      return json({ error: "stream identity or capability replay rejected" }, 409);
    }
    return json({ error: "bridge session unavailable" }, 409);
  }
}
