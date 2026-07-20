import { assertBoundedString, assertExactObject, parseCappedJson } from "./safe-json.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const TWILIO_ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;
const TWILIO_CALL_SID = /^CA[0-9a-fA-F]{32}$/;
const TWILIO_STREAM_SID = /^MZ[0-9a-fA-F]{32}$/;
const PROVIDER_KEY_PREFIX = /^(?:sk-(?:proj-|svcacct-)?|xai-|AIza)/;
const JSON_CONTENT_TYPE = /^application\/(?:[A-Za-z0-9!#$&^_.+-]+\+)?json(?:\s*;|\s*$)/i;
const MAX_RESPONSE_CHUNKS = 4_096;
const REDACTED_ERROR_MESSAGE = "bootstrap exchange failed";
const ROTATION_ENDPOINT = "/api/telephony/bridge/capabilities/rotate";
const ROTATION_OVERLAP_MS = 5 * 60_000;
const CAPABILITY_GENERATION_TTL_MS = 30 * 60_000;
const SHA256 = /^[a-f0-9]{64}$/;

const CAPABILITY_BINDINGS = Object.freeze({
  event_capability: Object.freeze({ audience: "telephony_events", purpose: "event_journal" }),
  mcp_capability: Object.freeze({ audience: "bridge_mcp", purpose: "tool_invocation" }),
  renewal_capability: Object.freeze({ audience: "bridge_refresh", purpose: "capability_rotation" }),
});

/**
 * A deliberately redacted bootstrap failure.
 *
 * Callers can branch on `code` (and, for HTTP failures, `status`) without ever
 * logging a bearer token, response body, endpoint URL, or upstream error text.
 */
export class BootstrapClientError extends Error {
  constructor(code, { status } = {}) {
    super(REDACTED_ERROR_MESSAGE);
    this.name = "BootstrapClientError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

function failure(code, options) {
  return new BootstrapClientError(code, options);
}

function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function endpointUrl(appOrigin, path, allowInsecureLocalhost) {
  const origin = new URL(appOrigin);
  const secure = origin.protocol === "https:";
  if (!secure && !(allowInsecureLocalhost && origin.protocol === "http:" && isLoopback(origin.hostname))) {
    throw new TypeError("bootstrap authority requires HTTPS");
  }
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") {
    throw new TypeError("bootstrap appOrigin must be an exact origin");
  }
  if (typeof path !== "string" || !/^\/[A-Za-z0-9_./-]{1,255}$/.test(path) || path.includes("..")) {
    throw new TypeError("bootstrap path must be a bounded same-origin absolute path");
  }
  const endpoint = new URL(path, origin);
  if (endpoint.origin !== origin.origin || endpoint.pathname !== path || endpoint.search || endpoint.hash) {
    throw new TypeError("bootstrap endpoint escaped appOrigin");
  }
  return endpoint.toString();
}

async function abortable(promise, signal) {
  if (signal.aborted) throw signal.reason ?? failure("bootstrap_timeout");
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason ?? failure("bootstrap_timeout"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function cancelBody(body) {
  try {
    const cancellation = body?.cancel?.();
    Promise.resolve(cancellation).catch(() => undefined);
  } catch {
    // Cancellation is best-effort and must never replace the primary failure.
  }
}

function cancelReader(reader) {
  try {
    const cancellation = reader.cancel();
    Promise.resolve(cancellation).catch(() => undefined);
  } catch {
    // Cancellation is best-effort and must never replace the primary failure.
  }
}

function forwardExternalAbort(controller, externalSignal) {
  if (externalSignal === undefined) return () => {};
  if (!(externalSignal instanceof AbortSignal)) {
    throw new TypeError("bootstrap signal must be an AbortSignal");
  }
  const onAbort = () => controller.abort(failure("bootstrap_aborted"));
  if (externalSignal.aborted) onAbort();
  else externalSignal.addEventListener("abort", onAbort, { once: true });
  return () => externalSignal.removeEventListener("abort", onAbort);
}

async function responseBytes(response, maximumBytes, signal) {
  const advertised = response.headers?.get?.("content-length");
  if (advertised !== null && advertised !== undefined) {
    if (!/^\d+$/.test(advertised)) {
      cancelBody(response.body);
      throw failure("bootstrap_response_invalid");
    }
    const advertisedBytes = Number(advertised);
    if (!Number.isSafeInteger(advertisedBytes)) {
      cancelBody(response.body);
      throw failure("bootstrap_response_invalid");
    }
    if (advertisedBytes > maximumBytes) {
      cancelBody(response.body);
      throw failure("bootstrap_response_too_large");
    }
  }

  if (!response.body?.getReader) {
    if (typeof response.arrayBuffer !== "function") throw failure("bootstrap_response_invalid");
    const bytes = Buffer.from(await abortable(Promise.resolve().then(() => response.arrayBuffer()), signal));
    if (bytes.byteLength > maximumBytes) throw failure("bootstrap_response_too_large");
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let chunkCount = 0;
  let size = 0;
  let failed = false;
  try {
    while (true) {
      const part = await abortable(reader.read(), signal);
      if (!part || typeof part.done !== "boolean") throw failure("bootstrap_response_invalid");
      if (part.done) break;
      if (!ArrayBuffer.isView(part.value)) throw failure("bootstrap_response_invalid");
      chunkCount += 1;
      if (chunkCount > MAX_RESPONSE_CHUNKS) throw failure("bootstrap_response_too_fragmented");
      size += part.value.byteLength;
      if (!Number.isSafeInteger(size) || size > maximumBytes) throw failure("bootstrap_response_too_large");
      chunks.push(Buffer.from(part.value.buffer, part.value.byteOffset, part.value.byteLength));
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (failed || signal.aborted) cancelReader(reader);
    try {
      reader.releaseLock();
    } catch {
      // A hostile stream may leave a read pending after cancellation. The
      // primary bounded failure still takes precedence over cleanup details.
    }
  }
  return Buffer.concat(chunks, size);
}

function exactConnection(value) {
  try {
    return assertExactObject(value, {
      requiredKeys: ["account_sid", "call_sid", "stream_sid", "mode"],
    });
  } catch {
    throw failure("bootstrap_response_invalid");
  }
}

function validateCapabilityToken(value, field) {
  try {
    assertBoundedString(value, { minBytes: 16, maxBytes: 8_192, pattern: /^[^\s,\u0000-\u001f\u007f]+$/ });
  } catch {
    throw failure(`bootstrap_${field}_token_invalid`);
  }
  if (PROVIDER_KEY_PREFIX.test(value)) throw failure(`bootstrap_${field}_token_invalid`);
  return value;
}

function canonicalExpiry(value, now, maximumExpiresAt, errorCode) {
  if (typeof value !== "string") throw failure(errorCode);
  const expiresAt = Date.parse(value);
  if (
    !Number.isFinite(expiresAt) ||
    new Date(expiresAt).toISOString() !== value ||
    expiresAt <= now ||
    expiresAt > maximumExpiresAt
  ) {
    throw failure(errorCode);
  }
  return expiresAt;
}

function exactCapability(value, field, now, maximumExpiresAt) {
  let capability;
  try {
    capability = assertExactObject(value, {
      requiredKeys: ["token", "expires_at", "audience", "purpose"],
    });
  } catch {
    throw failure("bootstrap_response_invalid");
  }
  const expected = CAPABILITY_BINDINGS[field];
  if (capability.audience !== expected.audience) {
    throw failure(`bootstrap_${field}_audience_invalid`);
  }
  if (capability.purpose !== expected.purpose) {
    throw failure(`bootstrap_${field}_purpose_invalid`);
  }
  validateCapabilityToken(capability.token, field);
  canonicalExpiry(
    capability.expires_at,
    now,
    maximumExpiresAt,
    `bootstrap_${field}_expiry_invalid`,
  );
  return capability;
}

function validateRequest({ sessionId, bridgeToken, accountSid, callSid, streamSid, mode, bridgeInstanceId }) {
  try {
    for (const value of [sessionId, bridgeInstanceId]) {
      assertBoundedString(value, { maxBytes: 256, pattern: SAFE_ID });
    }
    assertBoundedString(accountSid, { maxBytes: 34, pattern: TWILIO_ACCOUNT_SID });
    assertBoundedString(callSid, { maxBytes: 34, pattern: TWILIO_CALL_SID });
    assertBoundedString(streamSid, { maxBytes: 34, pattern: TWILIO_STREAM_SID });
    // Twilio limits a single Media Streams custom parameter to 500 bytes.
    assertBoundedString(bridgeToken, { minBytes: 16, maxBytes: 500, pattern: /^[^\s,\u0000-\u001f\u007f]+$/ });
  } catch {
    throw failure("bootstrap_request_invalid");
  }
  if (PROVIDER_KEY_PREFIX.test(bridgeToken) || mode !== "agent") {
    throw failure("bootstrap_request_invalid");
  }
}

function validateWebSocketUrl(value) {
  try {
    assertBoundedString(value, { maxBytes: 2_048, pattern: /^[^\u0000-\u001f\u007f]+$/ });
    const url = new URL(value);
    if (url.protocol !== "wss:" || url.username || url.password || url.hash || url.href !== value) {
      throw new Error("invalid");
    }
  } catch {
    throw failure("bootstrap_ws_url_invalid");
  }
}

function validateResponseShape(payload) {
  try {
    return assertExactObject(payload, {
      requiredKeys: [
        "schema_version", "session_id", "call_id", "connection",
        "provider", "model", "ws_url", "session_update", "event_capability",
        "mcp_capability", "renewal_capability", "bridge_instance_id", "rotation",
        "rotation_endpoint", "refresh_after", "expires_at", "active_catalog_authority",
      ],
    });
  } catch {
    throw failure("bootstrap_response_invalid");
  }
}

function exactActiveCatalogAuthority(value) {
  let authority;
  try {
    authority = assertExactObject(value, {
      requiredKeys: ["catalog_digest", "capability_epoch"],
    });
  } catch {
    throw failure("bootstrap_active_catalog_authority_invalid");
  }
  if (typeof authority.catalog_digest !== "string" || !SHA256.test(authority.catalog_digest) ||
      !Number.isSafeInteger(authority.capability_epoch) || authority.capability_epoch < 0) {
    throw failure("bootstrap_active_catalog_authority_invalid");
  }
  return Object.freeze({
    catalogDigest: authority.catalog_digest,
    capabilityEpoch: authority.capability_epoch,
  });
}

export class BootstrapClient {
  constructor({
    appOrigin,
    endpointPath = "/api/telephony/bridge/session",
    fetchImpl = globalThis.fetch,
    timeoutMs = 10_000,
    maximumResponseBytes = 1024 * 1024,
    allowInsecureLocalhost = false,
    now = Date.now,
  } = {}) {
    this.endpoint = endpointUrl(appOrigin, endpointPath, allowInsecureLocalhost);
    if (typeof fetchImpl !== "function") throw new TypeError("bootstrap fetchImpl must be a function");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
      throw new TypeError("bootstrap timeoutMs is invalid");
    }
    if (!Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes < 1_024 || maximumResponseBytes > 1024 * 1024) {
      throw new TypeError("bootstrap maximumResponseBytes is invalid");
    }
    if (typeof now !== "function") throw new TypeError("bootstrap now must be a function");
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maximumResponseBytes = maximumResponseBytes;
    this.now = now;
  }

  async createSession(
    { sessionId, bridgeToken, accountSid, callSid, streamSid, mode, bridgeInstanceId } = {},
    { signal: externalSignal } = {},
  ) {
    validateRequest({ sessionId, bridgeToken, accountSid, callSid, streamSid, mode, bridgeInstanceId });

    const connection = Object.freeze({
      account_sid: accountSid,
      call_sid: callSid,
      stream_sid: streamSid,
      mode,
    });
    const requestBody = JSON.stringify({
      schema_version: 3,
      session_id: sessionId,
      bridge_instance_id: bridgeInstanceId,
      connection,
    });
    const controller = new AbortController();
    const timeoutError = failure("bootstrap_timeout");
    const detachExternalAbort = forwardExternalAbort(controller, externalSignal);
    const timer = setTimeout(() => controller.abort(timeoutError), this.timeoutMs);
    let phase = "fetch";

    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      const response = await abortable(Promise.resolve().then(() => this.fetch(this.endpoint, {
        method: "POST",
        redirect: "error",
        credentials: "omit",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${bridgeToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Idempotency-Key": sessionId,
        },
        body: requestBody,
      })), controller.signal);
      phase = "response";

      if (
        !response ||
        typeof response.ok !== "boolean" ||
        !Number.isInteger(response.status) ||
        response.status < 100 ||
        response.status > 599
      ) {
        throw failure("bootstrap_response_invalid");
      }
      if (!response.ok) {
        cancelBody(response.body);
        throw failure(`bootstrap_http_${response.status}`, { status: response.status });
      }
      const contentType = response.headers?.get?.("content-type");
      if (typeof contentType !== "string" || !JSON_CONTENT_TYPE.test(contentType)) {
        cancelBody(response.body);
        throw failure("bootstrap_content_type_invalid");
      }

      const bytes = await responseBytes(response, this.maximumResponseBytes, controller.signal);
      let payload;
      try {
        payload = parseCappedJson(bytes, {
          maxBytes: this.maximumResponseBytes,
          maxDepth: 48,
          maxNodes: 32_768,
          maxObjectKeys: 512,
          maxArrayLength: 8_192,
          maxStringBytes: 256 * 1024,
        });
      } catch {
        throw failure("bootstrap_response_invalid");
      }

      const result = validateResponseShape(payload);
      if (result.schema_version !== 3 || result.session_id !== sessionId ||
          result.bridge_instance_id !== bridgeInstanceId || result.rotation !== 0) {
        throw failure("bootstrap_binding_mismatch");
      }
      const echoed = exactConnection(result.connection);
      if (Object.keys(connection).some((key) => echoed[key] !== connection[key])) {
        throw failure("bootstrap_connection_mismatch");
      }
      try {
        assertBoundedString(result.call_id, { maxBytes: 256, pattern: SAFE_ID });
        assertBoundedString(result.model, { maxBytes: 256, pattern: /^[^\u0000-\u001f\u007f]+$/ });
      } catch {
        throw failure("bootstrap_response_invalid");
      }
      if (result.provider !== "openai" && result.provider !== "xai") {
        throw failure("bootstrap_provider_unsupported");
      }
      validateWebSocketUrl(result.ws_url);
      if (
        !result.session_update ||
        typeof result.session_update !== "object" ||
        Array.isArray(result.session_update) ||
        (Object.getPrototypeOf(result.session_update) !== Object.prototype && Object.getPrototypeOf(result.session_update) !== null)
      ) {
        throw failure("bootstrap_session_update_invalid");
      }

      const nowMs = this.now();
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw failure("bootstrap_clock_invalid");
      // Call duration and capability lifetime are separate: long calls rotate
      // authority, while every individual generation is capped at 30 minutes.
      const maximumExpiresAt = nowMs + CAPABILITY_GENERATION_TTL_MS;
      const expiresAtMs = canonicalExpiry(
        result.expires_at,
        nowMs,
        maximumExpiresAt,
        "bootstrap_expiry_invalid",
      );
      const refreshAfterMs = canonicalExpiry(
        result.refresh_after,
        nowMs,
        expiresAtMs,
        "bootstrap_refresh_after_invalid",
      );
      if (expiresAtMs - refreshAfterMs !== ROTATION_OVERLAP_MS ||
          result.rotation_endpoint !== ROTATION_ENDPOINT) {
        throw failure("bootstrap_rotation_invalid");
      }
      const eventCapability = exactCapability(result.event_capability, "event_capability", nowMs, expiresAtMs);
      const mcpCapability = exactCapability(result.mcp_capability, "mcp_capability", nowMs, expiresAtMs);
      const renewalCapability = exactCapability(
        result.renewal_capability,
        "renewal_capability",
        nowMs,
        expiresAtMs,
      );
      if (
        new Set([
          eventCapability.token,
          mcpCapability.token,
          renewalCapability.token,
          bridgeToken,
        ]).size !== 4 ||
        eventCapability.expires_at !== result.expires_at ||
        mcpCapability.expires_at !== result.expires_at ||
        renewalCapability.expires_at !== result.expires_at
      ) {
        throw failure("bootstrap_capability_separation_invalid");
      }
      const activeCatalogAuthority = exactActiveCatalogAuthority(result.active_catalog_authority);

      return Object.freeze({
        sessionId,
        bridgeInstanceId,
        callId: result.call_id,
        connection,
        provider: result.provider,
        model: result.model,
        wsUrl: result.ws_url,
        sessionUpdate: result.session_update,
        eventCapability: Object.freeze({
          token: eventCapability.token,
          audience: eventCapability.audience,
          purpose: eventCapability.purpose,
          expiresAt: eventCapability.expires_at,
        }),
        mcpCapability: Object.freeze({
          token: mcpCapability.token,
          audience: mcpCapability.audience,
          purpose: mcpCapability.purpose,
          expiresAt: mcpCapability.expires_at,
        }),
        renewalCapability: Object.freeze({
          token: renewalCapability.token,
          audience: renewalCapability.audience,
          purpose: renewalCapability.purpose,
          expiresAt: renewalCapability.expires_at,
        }),
        activeCatalogAuthority,
        rotation: result.rotation,
        rotationEndpoint: result.rotation_endpoint,
        refreshAfter: result.refresh_after,
        expiresAt: result.expires_at,
      });
    } catch (error) {
      if (error instanceof BootstrapClientError) throw error;
      if (controller.signal.aborted && controller.signal.reason instanceof BootstrapClientError) {
        throw controller.signal.reason;
      }
      throw failure(phase === "fetch" ? "bootstrap_network_error" : "bootstrap_response_invalid");
    } finally {
      clearTimeout(timer);
      detachExternalAbort();
    }
  }
}

export const bootstrapInternals = Object.freeze({ endpointUrl });
