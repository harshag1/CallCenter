import { assertBoundedString, assertExactObject, parseCappedJson } from "./safe-json.js";

const DEFAULT_ENDPOINT = "/api/telephony/bridge/capabilities/rotate";
const JSON_CONTENT_TYPE = /^application\/(?:[A-Za-z0-9!#$&^_.+-]+\+)?json(?:\s*;|\s*$)/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;
const CALL_SID = /^CA[0-9a-fA-F]{32}$/;
const STREAM_SID = /^MZ[0-9a-fA-F]{32}$/;
const PROVIDER_KEY_PREFIX = /^(?:sk-(?:proj-|svcacct-)?|xai-|AIza)/;
const OVERLAP_MS = 5 * 60_000;
const CAPABILITY_GENERATION_TTL_MS = 30 * 60_000;
const MAX_ROTATION = 1_000_000;
const MAX_RESPONSE_CHUNKS = 4_096;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const CAPABILITY_BINDINGS = Object.freeze({
  event_capability: Object.freeze({ audience: "telephony_events", purpose: "event_journal" }),
  mcp_capability: Object.freeze({ audience: "bridge_mcp", purpose: "tool_invocation" }),
  renewal_capability: Object.freeze({ audience: "bridge_refresh", purpose: "capability_rotation" }),
});

export class CapabilityRotationError extends Error {
  constructor(code, { status, retryable = false, indeterminate = false } = {}) {
    super("capability rotation failed");
    this.name = "CapabilityRotationError";
    this.code = code;
    this.retryable = retryable;
    this.indeterminate = indeterminate;
    if (status !== undefined) this.status = status;
  }
}

function failure(code, options) {
  return new CapabilityRotationError(code, options);
}

function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function rotationEndpoint(appOrigin, endpointPath, allowInsecureLocalhost) {
  let origin;
  try { origin = new URL(appOrigin); }
  catch { throw new TypeError("rotation appOrigin must be a valid origin"); }
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") {
    throw new TypeError("rotation appOrigin must be an exact credential-free origin");
  }
  if (origin.protocol !== "https:" &&
      !(allowInsecureLocalhost && origin.protocol === "http:" && isLoopback(origin.hostname))) {
    throw new TypeError("capability rotation requires HTTPS");
  }
  if (endpointPath !== DEFAULT_ENDPOINT) {
    throw new TypeError(`rotation endpoint must be ${DEFAULT_ENDPOINT}`);
  }
  const endpoint = new URL(endpointPath, origin);
  if (endpoint.origin !== origin.origin || endpoint.pathname !== DEFAULT_ENDPOINT || endpoint.href !== `${origin.origin}${DEFAULT_ENDPOINT}`) {
    throw new TypeError("rotation endpoint escaped the application origin");
  }
  return endpoint.toString();
}

function validateToken(value, label) {
  try {
    assertBoundedString(value, {
      minBytes: 16,
      maxBytes: 8_192,
      pattern: /^[^\s,\u0000-\u001f\u007f]+$/,
    });
  } catch {
    throw failure(`rotation_${label}_token_invalid`);
  }
  if (PROVIDER_KEY_PREFIX.test(value)) throw failure(`rotation_${label}_token_invalid`);
  return value;
}

function forwardExternalAbort(controller, externalSignal) {
  if (externalSignal === undefined) return () => {};
  if (!(externalSignal instanceof AbortSignal)) {
    throw new TypeError("rotation signal must be an AbortSignal");
  }
  const onAbort = () => controller.abort(failure("rotation_aborted"));
  if (externalSignal.aborted) onAbort();
  else externalSignal.addEventListener("abort", onAbort, { once: true });
  return () => externalSignal.removeEventListener("abort", onAbort);
}

function exactConnection(value) {
  let connection;
  try {
    connection = assertExactObject(value, {
      requiredKeys: ["account_sid", "call_sid", "stream_sid", "mode"],
    });
    assertBoundedString(connection.account_sid, { maxBytes: 34, pattern: ACCOUNT_SID });
    assertBoundedString(connection.call_sid, { maxBytes: 34, pattern: CALL_SID });
    assertBoundedString(connection.stream_sid, { maxBytes: 34, pattern: STREAM_SID });
  } catch {
    throw failure("rotation_connection_invalid");
  }
  if (connection.mode !== "agent") throw failure("rotation_connection_invalid");
  return Object.freeze({
    account_sid: connection.account_sid,
    call_sid: connection.call_sid,
    stream_sid: connection.stream_sid,
    mode: "agent",
  });
}

function canonicalTime(value, code) {
  if (typeof value !== "string") throw failure(code);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) throw failure(code);
  return milliseconds;
}

function exactCapability(value, field, expiresAt) {
  let capability;
  try {
    capability = assertExactObject(value, {
      requiredKeys: ["token", "expires_at", "audience", "purpose"],
    });
  } catch {
    throw failure("rotation_response_invalid");
  }
  const expected = CAPABILITY_BINDINGS[field];
  if (capability.audience !== expected.audience) throw failure(`rotation_${field}_audience_invalid`);
  if (capability.purpose !== expected.purpose) throw failure(`rotation_${field}_purpose_invalid`);
  if (capability.expires_at !== expiresAt) throw failure(`rotation_${field}_expiry_invalid`);
  validateToken(capability.token, field);
  return Object.freeze({
    token: capability.token,
    audience: capability.audience,
    purpose: capability.purpose,
    expiresAt: capability.expires_at,
  });
}

function validateRequest(input, now) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw failure("rotation_request_invalid");
  const keys = Object.keys(input).sort();
  const expected = [
    "bridgeInstanceId", "connection", "eventToken", "expectedCallId",
    "expiresAt", "mcpToken", "renewalToken", "rotation", "sessionId",
  ].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw failure("rotation_request_invalid");
  }
  try {
    assertBoundedString(input.sessionId, { maxBytes: 256, pattern: SAFE_ID });
    assertBoundedString(input.bridgeInstanceId, { maxBytes: 256, pattern: SAFE_ID });
    assertBoundedString(input.expectedCallId, { maxBytes: 256, pattern: SAFE_ID });
  } catch {
    throw failure("rotation_request_invalid");
  }
  if (!Number.isSafeInteger(input.rotation) || input.rotation < 1 || input.rotation > MAX_ROTATION) {
    throw failure("rotation_request_invalid");
  }
  const expiresAtMs = canonicalTime(input.expiresAt, "rotation_request_invalid");
  if (expiresAtMs <= now) throw failure("rotation_capability_expired");
  if (expiresAtMs > now + CAPABILITY_GENERATION_TTL_MS) {
    throw failure("rotation_capability_expiry_invalid");
  }
  const eventToken = validateToken(input.eventToken, "current_event_capability");
  const mcpToken = validateToken(input.mcpToken, "current_mcp_capability");
  const renewalToken = validateToken(input.renewalToken, "renewal_capability");
  if (new Set([eventToken, mcpToken, renewalToken]).size !== 3) {
    throw failure("rotation_capability_separation_invalid");
  }
  return Object.freeze({
    sessionId: input.sessionId,
    bridgeInstanceId: input.bridgeInstanceId,
    expectedCallId: input.expectedCallId,
    rotation: input.rotation,
    connection: exactConnection(input.connection),
    eventToken,
    mcpToken,
    renewalToken,
    expiresAt: input.expiresAt,
    expiresAtMs,
  });
}

function validateResponse(payload, request, now) {
  let result;
  try {
    result = assertExactObject(payload, {
      requiredKeys: [
        "schema_version", "session_id", "bridge_instance_id", "call_id", "connection",
        "rotation", "refresh_after", "event_capability", "mcp_capability",
        "renewal_capability", "expires_at",
      ],
    });
  } catch {
    throw failure("rotation_response_invalid");
  }
  if (result.schema_version !== 1 || result.session_id !== request.sessionId ||
      result.bridge_instance_id !== request.bridgeInstanceId || result.call_id !== request.expectedCallId ||
      result.rotation !== request.rotation) {
    throw failure("rotation_binding_mismatch");
  }
  const echoed = exactConnection(result.connection);
  if (Object.keys(request.connection).some((key) => echoed[key] !== request.connection[key])) {
    throw failure("rotation_binding_mismatch");
  }
  const refreshAfterMs = canonicalTime(result.refresh_after, "rotation_refresh_after_invalid");
  const expiresAtMs = canonicalTime(result.expires_at, "rotation_expiry_invalid");
  if (refreshAfterMs <= now || expiresAtMs <= refreshAfterMs ||
      expiresAtMs - refreshAfterMs !== OVERLAP_MS ||
      expiresAtMs <= request.expiresAtMs ||
      expiresAtMs > now + CAPABILITY_GENERATION_TTL_MS) {
    throw failure("rotation_expiry_invalid");
  }
  const eventCapability = exactCapability(result.event_capability, "event_capability", result.expires_at);
  const mcpCapability = exactCapability(result.mcp_capability, "mcp_capability", result.expires_at);
  const renewalCapability = exactCapability(result.renewal_capability, "renewal_capability", result.expires_at);
  if (new Set([
    eventCapability.token,
    mcpCapability.token,
    renewalCapability.token,
    request.eventToken,
    request.mcpToken,
    request.renewalToken,
  ]).size !== 6) {
    throw failure("rotation_capability_separation_invalid");
  }
  return Object.freeze({
    sessionId: result.session_id,
    bridgeInstanceId: result.bridge_instance_id,
    callId: result.call_id,
    connection: echoed,
    rotation: result.rotation,
    refreshAfter: result.refresh_after,
    expiresAt: result.expires_at,
    eventCapability,
    mcpCapability,
    renewalCapability,
  });
}

async function abortable(promise, signal) {
  if (signal.aborted) throw signal.reason ?? failure("rotation_timeout");
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? failure("rotation_timeout"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function responseBytes(response, maximumBytes, signal) {
  const advertised = response.headers?.get?.("content-length");
  if (advertised !== null && advertised !== undefined &&
      (!/^\d+$/.test(advertised) || Number(advertised) > maximumBytes)) {
    void response.body?.cancel?.().catch(() => undefined);
    throw failure("rotation_response_too_large");
  }
  if (!response.body?.getReader) {
    throw failure("rotation_response_invalid", { retryable: true, indeterminate: true });
  }
  const reader = response.body.getReader();
  const chunks = [];
  let count = 0;
  let size = 0;
  try {
    while (true) {
      const part = await abortable(reader.read(), signal);
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) {
        throw failure("rotation_response_invalid", { retryable: true, indeterminate: true });
      }
      count += 1;
      size += part.value.byteLength;
      if (count > MAX_RESPONSE_CHUNKS || size > maximumBytes) {
        void reader.cancel().catch(() => undefined);
        throw failure("rotation_response_too_large");
      }
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return Buffer.concat(chunks, size);
}

export class CapabilityRotationClient {
  constructor({
    appOrigin,
    endpointPath = DEFAULT_ENDPOINT,
    fetchImpl = globalThis.fetch,
    timeoutMs = 10_000,
    maximumAttempts = 3,
    maximumResponseBytes = 256 * 1024,
    allowInsecureLocalhost = false,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}) {
    this.endpoint = rotationEndpoint(appOrigin, endpointPath, allowInsecureLocalhost);
    if (typeof fetchImpl !== "function" || typeof now !== "function" || typeof sleep !== "function") {
      throw new TypeError("rotation client dependencies are invalid");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000 ||
        !Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 3 ||
        !Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes < 1_024 || maximumResponseBytes > 1024 * 1024) {
      throw new TypeError("rotation client limits are invalid");
    }
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maximumAttempts = maximumAttempts;
    this.maximumResponseBytes = maximumResponseBytes;
    this.now = now;
    this.sleep = sleep;
  }

  async rotate(input, { signal: externalSignal } = {}) {
    const startedAt = this.now();
    if (!Number.isSafeInteger(startedAt) || startedAt < 0) throw failure("rotation_clock_invalid");
    const request = validateRequest(input, startedAt);
    const body = JSON.stringify({
      schema_version: 1,
      session_id: request.sessionId,
      bridge_instance_id: request.bridgeInstanceId,
      rotation: request.rotation,
      connection: request.connection,
    });
    const idempotencyKey = `${request.sessionId}:${request.rotation}`;
    const controller = new AbortController();
    const timeoutError = failure("rotation_timeout", { indeterminate: true });
    const detachExternalAbort = forwardExternalAbort(controller, externalSignal);
    const timer = setTimeout(() => controller.abort(timeoutError), this.timeoutMs);
    let lastError;
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      for (let attempt = 1; attempt <= this.maximumAttempts; attempt += 1) {
        if (this.now() >= request.expiresAtMs) throw failure("rotation_capability_expired");
        try {
          const response = await abortable(Promise.resolve().then(() => this.fetch(this.endpoint, {
            method: "POST",
            redirect: "error",
            credentials: "omit",
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${request.renewalToken}`,
              Accept: "application/json",
              "Content-Type": "application/json",
              "Cache-Control": "no-store",
              "Idempotency-Key": idempotencyKey,
            },
            body,
          })), controller.signal);
          if (!response || !Number.isInteger(response.status)) {
            throw failure("rotation_response_invalid", { retryable: true, indeterminate: true });
          }
          if (!response.ok) {
            void response.body?.cancel?.().catch(() => undefined);
            throw failure(`rotation_http_${response.status}`, {
              status: response.status,
              retryable: RETRYABLE_STATUS.has(response.status),
              indeterminate: RETRYABLE_STATUS.has(response.status),
            });
          }
          const contentType = response.headers?.get?.("content-type");
          if (typeof contentType !== "string" || !JSON_CONTENT_TYPE.test(contentType)) {
            void response.body?.cancel?.().catch(() => undefined);
            throw failure("rotation_content_type_invalid", { retryable: true, indeterminate: true });
          }
          const bytes = await responseBytes(response, this.maximumResponseBytes, controller.signal);
          let payload;
          try {
            payload = parseCappedJson(bytes, {
              maxBytes: this.maximumResponseBytes,
              maxDepth: 32,
              maxNodes: 16_384,
              maxObjectKeys: 256,
              maxArrayLength: 4_096,
              maxStringBytes: 256 * 1024,
            });
          } catch {
            throw failure("rotation_response_invalid", { retryable: true, indeterminate: true });
          }
          const responseNow = this.now();
          if (!Number.isSafeInteger(responseNow) || responseNow < 0) throw failure("rotation_clock_invalid");
          if (responseNow >= request.expiresAtMs) throw failure("rotation_capability_expired", { indeterminate: true });
          return validateResponse(payload, request, responseNow);
        } catch (error) {
          const typed = error instanceof CapabilityRotationError
            ? error
            : failure("rotation_network_error", { retryable: true, indeterminate: true });
          lastError = typed;
          if (controller.signal.aborted && controller.signal.reason instanceof CapabilityRotationError) {
            throw controller.signal.reason;
          }
          if (!typed.retryable || attempt === this.maximumAttempts) throw typed;
          await abortable(this.sleep(Math.min(500, 50 * (2 ** (attempt - 1)))), controller.signal);
        }
      }
      throw lastError ?? failure("rotation_network_error", { indeterminate: true });
    } finally {
      clearTimeout(timer);
      detachExternalAbort();
    }
  }
}

export const capabilityRotationInternals = Object.freeze({ rotationEndpoint });
