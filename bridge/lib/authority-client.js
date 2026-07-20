import { createHash } from "node:crypto";
import { parseCappedJson } from "./safe-json.js";

// The public gateway envelope is capped at 896 KiB before it is encoded as an
// MCP text item. JSON string escaping can nearly double that wire size.
const MAX_RPC_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RPC_REQUEST_BYTES = 256 * 1024;
const MAX_SCOPE_BYTES = 8_000;
const MAX_TRACKED_CALLS = 10_000;
const MAX_IN_FLIGHT_CALLS = 128;
const DEFAULT_RETAINED_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_RETAINED_RESULT_BYTES = 64 * 1024 * 1024;
const MAX_INPUT_DEPTH = 32;
const MAX_INPUT_NODES = 16_384;
const MAX_INPUT_OBJECT_KEYS = 256;
const MAX_INPUT_ARRAY_LENGTH = 4_096;
const MAX_INPUT_STRING_BYTES = 256 * 1024;
const MAX_INPUT_KEY_BYTES = 256;
const MCP_PROTOCOL_VERSION = "2025-11-25";
const MCP_PROVIDER_TOOL_CALL_ID_META_KEY = "hacc/provider_tool_call_id";
const MCP_ACTIVE_CATALOG_META_KEY = "com.harsha.callcenter/active-catalog";
const MCP_MAX_PROVIDER_TOOL_CALL_ID_BYTES = 256;
const MCP_SESSION_ID = /^hacc\.v1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
const MCP_INITIALIZE_RPC_ID = "bridge-initialize:v1";
const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const PROVIDER_CALL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PROVIDER_ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;

export class AuthorityClientError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "AuthorityClientError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.indeterminate = options.indeterminate ?? false;
    this.status = options.status;
    this.executionStarted = options.executionStarted ?? null;
  }
}

/**
 * A stable, bounded JSON-RPC id derived from provider call provenance. The
 * authenticated call scope remains server-side authority; these values are
 * transport correlation only, never authorization or durable execution
 * identity. Durable authority receipts use the native provider callId carried
 * in client-owned MCP params._meta.
 */
export function providerCallRpcId(identity) {
  const normalized = normalizeProviderCallIdentity(identity);
  const digest = createHash("sha256")
    .update("hacc/bridge-provider-call/v1\0", "utf8")
    .update(canonicalJson(normalized), "utf8")
    .digest("hex");
  return `bridge-call:v1:${digest}`;
}

/**
 * Narrow client for the same-origin MCP `tools/call` authority. It deliberately
 * has no provider-key/header option and exposes only `capability_gateway`.
 */
export class AuthorityClient {
  #scopeToken;
  #endpoint;
  #fetch;
  #timeoutMs;
  #maximumResponseBytes;
  #maximumAttempts;
  #sleep;
  #maximumRetainedResultBytes;
  #calls = new Map();
  #callIdentityByProviderId = new Map();
  #settledOrder = [];
  #retainedResultBytes = 0;
  #inFlightCalls = 0;
  #sessionId;
  #protocolVersion;
  #initializationPromise;
  #initializationController;
  #closed = false;
  #lifecycleController = new AbortController();

  constructor(options) {
    if (!isRecord(options)) throw localError("invalid_options", "AuthorityClient options must be an object");
    const allowedOptions = new Set([
      "appOrigin",
      "endpoint",
      "scopeToken",
      "fetchImpl",
      "timeoutMs",
      "maximumResponseBytes",
      "maximumAttempts",
      "maximumRetainedResultBytes",
      "sleep",
      "allowInsecureLocalhostForTests",
    ]);
    if (Object.keys(options).some((key) => !allowedOptions.has(key))) {
      throw localError("invalid_options", "AuthorityClient options contain an unsupported field");
    }
    this.#endpoint = sameOriginMcpEndpoint(options.appOrigin, options.endpoint, options.allowInsecureLocalhostForTests === true);
    this.#scopeToken = validateScopeToken(options.scopeToken);
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    if (typeof this.#fetch !== "function") throw localError("invalid_options", "AuthorityClient requires fetch");
    this.#timeoutMs = boundedPositiveInteger(options.timeoutMs ?? 12_000, "timeoutMs", 60_000);
    this.#maximumResponseBytes = boundedPositiveInteger(
      options.maximumResponseBytes ?? MAX_RPC_RESPONSE_BYTES,
      "maximumResponseBytes",
      MAX_RPC_RESPONSE_BYTES,
    );
    this.#maximumAttempts = boundedPositiveInteger(options.maximumAttempts ?? 2, "maximumAttempts", 3);
    this.#maximumRetainedResultBytes = boundedPositiveInteger(
      options.maximumRetainedResultBytes ?? DEFAULT_RETAINED_RESULT_BYTES,
      "maximumRetainedResultBytes",
      MAX_RETAINED_RESULT_BYTES,
    );
    this.#sleep = options.sleep ?? defaultSleep;
    if (typeof this.#sleep !== "function") throw localError("invalid_options", "sleep must be a function");
    Object.freeze(this);
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#lifecycleController.abort(new Error("authority_closed"));
  }

  /**
   * Call the single provider-visible gateway. Exact concurrent/repeated calls
   * coalesce; reuse of the same provider identity with different arguments is
   * rejected before network I/O. All retry attempts retain the same RPC id.
   */
  callCapabilityGateway(input) {
    if (this.#closed) {
      return Promise.reject(new AuthorityClientError(
        "authority_closed",
        "Authority client is closed",
        { retryable: false, indeterminate: false, executionStarted: false },
      ));
    }
    const request = normalizeGatewayCall(input);
    const providerCallKey = `${request.identity.provider}\0${request.identity.callId}`;
    const identityFingerprint = canonicalJson(request.identity);
    const priorIdentity = this.#callIdentityByProviderId.get(providerCallKey);
    if (priorIdentity !== undefined && priorIdentity !== identityFingerprint) {
      return Promise.reject(localError(
        "provider_call_identity_conflict",
        "Provider callId was reused with different response or item provenance",
      ));
    }
    const rpcId = providerCallRpcId(request.identity);
    const callFingerprint = sha256(canonicalJson({
      rpcId,
      name: request.toolName,
      arguments: request.arguments,
      activeCatalogAuthority: request.activeCatalogAuthority,
    }));
    const prior = this.#calls.get(rpcId);
    if (prior) {
      if (prior.fingerprint !== callFingerprint) {
        return Promise.reject(localError(
          "provider_call_identity_conflict",
          "Provider call identity was reused with different gateway arguments",
        ));
      }
      if (prior.state === "pending") return prior.promise;
      if (prior.state === "result") return Promise.resolve(prior.result);
      if (prior.state === "error") return Promise.reject(prior.error);
      return Promise.reject(new AuthorityClientError(
        "replay_result_evicted",
        "The authority outcome is settled but no longer retained in this bridge process",
        {
          retryable: false,
          indeterminate: prior.evictedIndeterminate === true,
          executionStarted: prior.evictedExecutionStarted,
        },
      ));
    }
    if (this.#calls.size >= MAX_TRACKED_CALLS) {
      return Promise.reject(localError("identity_limit", `Authority client exceeded ${MAX_TRACKED_CALLS} provider calls`));
    }
    if (this.#inFlightCalls >= MAX_IN_FLIGHT_CALLS) {
      return Promise.reject(localError("in_flight_limit", `Authority client exceeded ${MAX_IN_FLIGHT_CALLS} concurrent calls`));
    }
    this.#callIdentityByProviderId.set(providerCallKey, identityFingerprint);
    const entry = { fingerprint: callFingerprint, state: "pending", promise: undefined, retainedBytes: 0 };
    this.#calls.set(rpcId, entry);
    this.#inFlightCalls += 1;
    const operation = deadlineController(this.#timeoutMs, "authority_operation_timeout");
    const promise = this.#performCall(
      rpcId,
      request.toolName,
      request.arguments,
      request.identity.callId,
      request.activeCatalogAuthority,
      operation.signal,
    ).finally(operation.cleanup).then(
      (result) => {
        this.#settleResult(rpcId, entry, result);
        return result;
      },
      (error) => {
        const typed = error instanceof AuthorityClientError
          ? error
          : new AuthorityClientError("transport_error", "MCP transport failed", {
            retryable: true,
            indeterminate: true,
            executionStarted: null,
          });
        this.#settleError(rpcId, entry, typed);
        throw typed;
      },
    );
    entry.promise = promise;
    return promise;
  }

  async #performCall(rpcId, toolName, args, providerToolCallId, activeCatalogAuthority, operationSignal) {
    try {
      await this.#ensureInitialized(operationSignal);
    } catch (error) {
      if (operationSignal.aborted || this.#closed) {
        throw this.#abortFailure(operationSignal, false, error);
      }
      throw error;
    }
    const envelope = {
      jsonrpc: "2.0",
      id: rpcId,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
        _meta: {
          [MCP_PROVIDER_TOOL_CALL_ID_META_KEY]: providerToolCallId,
          [MCP_ACTIVE_CATALOG_META_KEY]: {
            catalog_digest: activeCatalogAuthority.catalogDigest,
            capability_epoch: activeCatalogAuthority.capabilityEpoch,
          },
        },
      },
    };
    const body = JSON.stringify(envelope);
    if (Buffer.byteLength(body, "utf8") > MAX_RPC_REQUEST_BYTES) {
      throw localError("request_too_large", `MCP request exceeds ${MAX_RPC_REQUEST_BYTES} bytes`);
    }

    let lastError;
    let attempt = 1;
    let sessionRecoveryAttempted = false;
    while (attempt <= this.#maximumAttempts) {
      const requestSessionId = this.#sessionId;
      try {
        const response = await this.#rpcAttempt(envelope, body, {
          sessionId: requestSessionId,
          protocolVersion: this.#protocolVersion,
          capabilityExecutionPossible: true,
          operationSignal,
        });
        return parseToolCallResult(response.result, this.#maximumResponseBytes);
      } catch (error) {
        const typed = error instanceof AuthorityClientError
          ? error
          : new AuthorityClientError("transport_error", "MCP transport failed", {
            retryable: true,
            indeterminate: true,
            executionStarted: null,
          });
        lastError = typed;
        if (typed.code === "mcp_session_expired" && !sessionRecoveryAttempted) {
          sessionRecoveryAttempted = true;
          this.#invalidateSession(requestSessionId);
          try {
            await this.#ensureInitialized(operationSignal);
          } catch (initializationError) {
            if (operationSignal.aborted || this.#closed) {
              throw this.#abortFailure(operationSignal, true, typed);
            }
            throw initializationError;
          }
          continue;
        }
        if (!typed.retryable || attempt === this.#maximumAttempts) throw typed;
        await this.#retryDelay(
          Math.min(500, 50 * (2 ** (attempt - 1))),
          operationSignal,
          true,
          typed,
        );
        attempt += 1;
      }
    }
    throw lastError ?? localError("transport_error", "MCP request failed");
  }

  #ensureInitialized(operationSignal) {
    if (this.#closed) return Promise.reject(this.#abortFailure(operationSignal, false));
    if (operationSignal?.aborted) return Promise.reject(this.#abortFailure(operationSignal, false));
    if (this.#sessionId && this.#protocolVersion) return Promise.resolve();
    if (!this.#initializationPromise) {
      const initialization = deadlineController(this.#timeoutMs, "authority_initialization_timeout");
      this.#initializationController = initialization.controller;
      const unlinkLifecycle = linkAbort(this.#lifecycleController.signal, initialization.controller);
      const pending = this.#initialize(initialization.signal).finally(() => {
        unlinkLifecycle();
        initialization.cleanup();
        if (this.#initializationController === initialization.controller) {
          this.#initializationController = undefined;
        }
        if (this.#initializationPromise === pending) this.#initializationPromise = undefined;
      });
      this.#initializationPromise = pending;
    }
    return operationSignal
      ? raceWithAbort(this.#initializationPromise, operationSignal)
      : this.#initializationPromise;
  }

  #invalidateSession(staleSessionId) {
    if (this.#sessionId !== staleSessionId) return;
    this.#sessionId = undefined;
    this.#protocolVersion = undefined;
  }

  async #initialize(initializationSignal) {
    const envelope = {
      jsonrpc: "2.0",
      id: MCP_INITIALIZE_RPC_ID,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: "harshas-amazing-call-center-bridge",
          version: "1.0.0",
        },
      },
    };
    const body = JSON.stringify(envelope);
    let lastError;
    for (let attempt = 1; attempt <= this.#maximumAttempts; attempt += 1) {
      try {
        const response = await this.#rpcAttempt(envelope, body, {
          initializing: true,
          capabilityExecutionPossible: false,
          operationSignal: initializationSignal,
        });
        const initialized = parseInitializeResult(response.result);
        const sessionId = validateMcpSessionId(response.sessionId);
        await this.#sendInitializedNotification(sessionId, initialized.protocolVersion, initializationSignal);
        // Publish the negotiated transport state atomically only after the
        // complete MCP lifecycle handshake succeeds.
        this.#protocolVersion = initialized.protocolVersion;
        this.#sessionId = sessionId;
        return;
      } catch (error) {
        const typed = error instanceof AuthorityClientError
          ? error
          : new AuthorityClientError("transport_error", "MCP initialization failed", {
            retryable: true,
            indeterminate: false,
            executionStarted: false,
          });
        lastError = typed;
        if (!typed.retryable || attempt === this.#maximumAttempts) throw typed;
        await this.#retryDelay(
          Math.min(500, 50 * (2 ** (attempt - 1))),
          initializationSignal,
          false,
          typed,
        );
      }
    }
    throw lastError ?? localError("transport_error", "MCP initialization failed");
  }

  async #sendInitializedNotification(sessionId, protocolVersion, initializationSignal) {
    const envelope = { jsonrpc: "2.0", method: "notifications/initialized" };
    const body = JSON.stringify(envelope);
    let lastError;
    for (let attempt = 1; attempt <= this.#maximumAttempts; attempt += 1) {
      try {
        await this.#notificationAttempt(body, sessionId, protocolVersion, initializationSignal);
        return;
      } catch (error) {
        const typed = error instanceof AuthorityClientError
          ? error
          : new AuthorityClientError("transport_error", "MCP initialized notification failed", {
            retryable: true,
            indeterminate: false,
            executionStarted: false,
          });
        lastError = typed;
        if (!typed.retryable || attempt === this.#maximumAttempts) throw typed;
        await this.#retryDelay(
          Math.min(500, 50 * (2 ** (attempt - 1))),
          initializationSignal,
          false,
          typed,
        );
      }
    }
    throw lastError ?? localError("transport_error", "MCP initialized notification failed");
  }

  async #rpcAttempt(envelope, body, options = {}) {
    if (this.#closed || options.operationSignal?.aborted) {
      throw this.#abortFailure(
        options.operationSignal,
        false,
      );
    }
    const controller = new AbortController();
    const unlinkLifecycle = linkAbort(this.#lifecycleController.signal, controller);
    const unlinkOperation = options.operationSignal
      ? linkAbort(options.operationSignal, controller)
      : () => {};
    const timer = setTimeout(() => controller.abort(new Error("authority_timeout")), this.#timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      unlinkLifecycle();
      unlinkOperation();
    };
    let response;
    try {
      response = await raceWithAbort(this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.#scopeToken}`,
          "Content-Type": "application/json",
          "Accept": "application/json",
          ...(options.sessionId ? { "MCP-Session-Id": options.sessionId } : {}),
          ...(options.protocolVersion ? { "MCP-Protocol-Version": options.protocolVersion } : {}),
        },
        body,
        signal: controller.signal,
        redirect: "error",
        cache: "no-store",
      }), controller.signal);
    } catch (error) {
      const externallyAborted = this.#closed || options.operationSignal?.aborted;
      const timedOut = controller.signal.aborted;
      cleanup();
      if (externallyAborted) {
        throw this.#abortFailure(
          options.operationSignal,
          options.capabilityExecutionPossible === true,
          error,
        );
      }
      throw new AuthorityClientError(
        timedOut ? "timeout" : "transport_error",
        timedOut ? `MCP request timed out after ${this.#timeoutMs} ms` : "MCP transport failed after dispatch began",
        {
          retryable: true,
          indeterminate: options.capabilityExecutionPossible === true,
          executionStarted: options.capabilityExecutionPossible === true ? null : false,
          cause: error,
        },
      );
    }
    try {
      if (!isResponseLike(response)) {
        throw new AuthorityClientError("invalid_response", "MCP transport returned a non-Response value", {
          retryable: false,
          indeterminate: options.capabilityExecutionPossible === true,
          executionStarted: options.capabilityExecutionPossible === true ? null : false,
        });
      }
      if (response.redirected) {
        await cancelBody(response);
        throw new AuthorityClientError("redirect_refused", "MCP authority redirects are not allowed", {
          indeterminate: options.capabilityExecutionPossible === true,
          executionStarted: options.capabilityExecutionPossible === true ? null : false,
        });
      }
      const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      const responseBody = await readBodyCapped(
        response,
        this.#maximumResponseBytes,
        controller.signal,
        this.#timeoutMs,
        options.capabilityExecutionPossible === true,
      );
      if (contentType !== "application/json") {
        throw new AuthorityClientError("invalid_content_type", "MCP response was not application/json", {
          status: response.status,
          retryable: RETRYABLE_HTTP_STATUS.has(response.status),
          indeterminate: options.capabilityExecutionPossible === true,
          executionStarted: options.capabilityExecutionPossible === true,
        });
      }

      let candidate;
      try {
        candidate = parseCappedJson(responseBody, {
          maxBytes: this.#maximumResponseBytes,
          maxDepth: 32,
          maxNodes: 16_384,
          maxObjectKeys: 256,
          maxArrayLength: 4_096,
          maxStringBytes: this.#maximumResponseBytes,
          maxKeyBytes: 256,
          maxNumberChars: 128,
        });
      } catch {
        throw new AuthorityClientError("invalid_json", "MCP response was not valid bounded UTF-8 JSON", {
          status: response.status,
          retryable: RETRYABLE_HTTP_STATUS.has(response.status),
          indeterminate: options.capabilityExecutionPossible === true,
          executionStarted: options.capabilityExecutionPossible === true,
        });
      }

      if (!response.ok) {
        if (response.status === 404 && isMcpSessionExpiredResponse(candidate, envelope.id)) {
          throw new AuthorityClientError(
            "mcp_session_expired",
            "MCP transport session expired before tool dispatch",
            { status: 404, retryable: false, indeterminate: false, executionStarted: false },
          );
        }
        throw new AuthorityClientError("http_error", `MCP authority returned HTTP ${response.status}`, {
          status: response.status,
          retryable: RETRYABLE_HTTP_STATUS.has(response.status),
          indeterminate: options.capabilityExecutionPossible === true &&
            (response.status >= 500 || response.status === 408 || response.status === 429),
          executionStarted: options.capabilityExecutionPossible === true,
        });
      }

      return {
        result: parseRpcResponse(candidate, envelope.id, options.capabilityExecutionPossible === true),
        sessionId: options.initializing ? response.headers.get("mcp-session-id") : null,
      };
    } catch (error) {
      if (this.#closed || options.operationSignal?.aborted) {
        throw this.#abortFailure(
          options.operationSignal,
          options.capabilityExecutionPossible === true,
          error,
        );
      }
      throw error;
    } finally {
      cleanup();
    }
  }

  async #notificationAttempt(body, sessionId, protocolVersion, operationSignal) {
    if (this.#closed || operationSignal?.aborted) {
      throw this.#abortFailure(operationSignal, false);
    }
    const controller = new AbortController();
    const unlinkLifecycle = linkAbort(this.#lifecycleController.signal, controller);
    const unlinkOperation = operationSignal ? linkAbort(operationSignal, controller) : () => {};
    const timer = setTimeout(() => controller.abort(new Error("authority_timeout")), this.#timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      unlinkLifecycle();
      unlinkOperation();
    };
    let response;
    try {
      response = await raceWithAbort(this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.#scopeToken}`,
          "Content-Type": "application/json",
          "Accept": "application/json",
          "MCP-Session-Id": sessionId,
          "MCP-Protocol-Version": protocolVersion,
        },
        body,
        signal: controller.signal,
        redirect: "error",
        cache: "no-store",
      }), controller.signal);
    } catch (error) {
      const externallyAborted = this.#closed || operationSignal?.aborted;
      const timedOut = controller.signal.aborted;
      cleanup();
      if (externallyAborted) throw this.#abortFailure(operationSignal, false, error);
      throw new AuthorityClientError(
        timedOut ? "timeout" : "transport_error",
        timedOut
          ? `MCP request timed out after ${this.#timeoutMs} ms`
          : "MCP initialized notification transport failed",
        { retryable: true, indeterminate: false, executionStarted: false, cause: error },
      );
    }
    try {
      if (!isResponseLike(response)) {
        throw new AuthorityClientError("invalid_response", "MCP transport returned a non-Response value", {
          retryable: false,
          indeterminate: false,
          executionStarted: false,
        });
      }
      if (response.redirected) {
        await cancelBody(response);
        throw new AuthorityClientError("redirect_refused", "MCP authority redirects are not allowed", {
          indeterminate: false,
          executionStarted: false,
        });
      }
      const responseBody = await readOptionalBodyCapped(
        response,
        this.#maximumResponseBytes,
        controller.signal,
        this.#timeoutMs,
        false,
      );
      if (response.status !== 202 && response.status !== 204) {
        throw new AuthorityClientError("http_error", `MCP authority returned HTTP ${response.status}`, {
          status: response.status,
          retryable: RETRYABLE_HTTP_STATUS.has(response.status),
          indeterminate: false,
          executionStarted: false,
        });
      }
      if (responseBody.byteLength !== 0) {
        throw new AuthorityClientError("invalid_response", "MCP initialized notification response must be empty", {
          indeterminate: false,
          executionStarted: false,
        });
      }
    } catch (error) {
      if (this.#closed || operationSignal?.aborted) {
        throw this.#abortFailure(operationSignal, false, error);
      }
      throw error;
    } finally {
      cleanup();
    }
  }

  async #retryDelay(ms, signal, capabilityExecutionPossible, priorError) {
    if (this.#closed || signal?.aborted) {
      throw this.#abortFailure(signal, capabilityExecutionPossible, priorError);
    }
    try {
      const sleeping = Promise.resolve(this.#sleep(ms));
      await Promise.race([
        raceWithAbort(sleeping, signal),
        raceWithAbort(sleeping, this.#lifecycleController.signal),
      ]);
    } catch (error) {
      if (this.#closed || signal?.aborted) {
        throw this.#abortFailure(signal, capabilityExecutionPossible, priorError ?? error);
      }
      throw error;
    }
  }

  #abortFailure(signal, capabilityExecutionPossible, priorError) {
    const closed = this.#closed || this.#lifecycleController.signal.aborted;
    const prior = priorError instanceof AuthorityClientError ? priorError : null;
    const indeterminate = capabilityExecutionPossible && (prior?.indeterminate !== false || prior === null);
    return new AuthorityClientError(
      closed ? "authority_closed" : "timeout",
      closed ? "Authority client closed before the operation settled" : `MCP operation timed out after ${this.#timeoutMs} ms`,
      {
        retryable: false,
        indeterminate,
        executionStarted: indeterminate ? (prior?.executionStarted ?? null) : false,
        cause: signal?.reason ?? priorError,
      },
    );
  }

  #settleResult(rpcId, entry, result) {
    this.#inFlightCalls -= 1;
    delete entry.promise;
    entry.state = "result";
    entry.result = result;
    this.#retainSettled(rpcId, entry, Buffer.byteLength(JSON.stringify(result), "utf8"));
  }

  #settleError(rpcId, entry, error) {
    this.#inFlightCalls -= 1;
    delete entry.promise;
    entry.state = "error";
    entry.error = compactAuthorityError(error);
    this.#retainSettled(rpcId, entry, Buffer.byteLength(entry.error.message, "utf8") + 256);
  }

  #retainSettled(rpcId, entry, bytes) {
    entry.retainedBytes = bytes;
    this.#retainedResultBytes += bytes;
    this.#settledOrder.push(rpcId);
    while (this.#retainedResultBytes > this.#maximumRetainedResultBytes && this.#settledOrder.length > 0) {
      const oldestId = this.#settledOrder.shift();
      const oldest = this.#calls.get(oldestId);
      if (!oldest || oldest.state === "pending" || oldest.state === "evicted") continue;
      this.#retainedResultBytes -= oldest.retainedBytes;
      oldest.evictedIndeterminate = oldest.state === "result" || oldest.error?.indeterminate === true;
      oldest.evictedExecutionStarted = oldest.state === "result"
        ? true
        : oldest.error?.executionStarted;
      oldest.retainedBytes = 0;
      delete oldest.result;
      delete oldest.error;
      oldest.state = "evicted";
    }
  }
}

function normalizeGatewayCall(input) {
  if (!isRecord(input)) throw localError("invalid_call", "Gateway call must be an object");
  const allowed = new Set([
    "provider", "responseId", "itemId", "callId", "name", "arguments", "activeCatalogAuthority",
  ]);
  const inputKeys = Reflect.ownKeys(input);
  if (inputKeys.some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw localError("invalid_call", "Gateway call contains an unsupported field");
  }
  for (const key of inputKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw localError("invalid_call", `Gateway call ${String(key)} must be an enumerable data property`);
    }
  }
  const providerName = Object.getOwnPropertyDescriptor(input, "name")?.value;
  if (providerName !== undefined && providerName !== "capability_gateway") {
    throw localError("tool_not_allowed", "Authority client allows only capability_gateway");
  }
  const gatewayArguments = Object.getOwnPropertyDescriptor(input, "arguments")?.value;
  if (!isRecord(gatewayArguments)) {
    throw localError("invalid_arguments", "capability_gateway arguments must be an object");
  }
  assertStrictJson(gatewayArguments, "capability_gateway arguments");
  const gatewayKeys = Object.keys(gatewayArguments).sort();
  if (gatewayKeys.length !== 2 || gatewayKeys[0] !== "arguments" || gatewayKeys[1] !== "tool_name") {
    throw localError(
      "invalid_arguments",
      "capability_gateway requires exactly tool_name and arguments; provenance is bridge-owned",
    );
  }
  const toolName = gatewayArguments.tool_name;
  if (typeof toolName !== "string" || !/^[a-z][a-z0-9_.-]{1,63}$/.test(toolName)) {
    throw localError("invalid_arguments", "capability_gateway tool_name is invalid");
  }
  const targetArguments = gatewayArguments.arguments;
  if (!isRecord(targetArguments)) {
    throw localError("invalid_arguments", "capability_gateway target arguments must be an object");
  }
  return {
    identity: normalizeProviderCallIdentity(input),
    toolName,
    arguments: deepFreeze(structuredClone(targetArguments)),
    activeCatalogAuthority: normalizeActiveCatalogAuthority(
      Object.getOwnPropertyDescriptor(input, "activeCatalogAuthority")?.value,
    ),
  };
}

function normalizeActiveCatalogAuthority(value) {
  if (!isRecord(value) || Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, "catalogDigest") || !Object.hasOwn(value, "capabilityEpoch") ||
      typeof value.catalogDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.catalogDigest) ||
      !Number.isSafeInteger(value.capabilityEpoch) || value.capabilityEpoch < 0) {
    throw localError("invalid_active_catalog_authority", "Active catalog authority is invalid");
  }
  return deepFreeze({
    catalogDigest: value.catalogDigest,
    capabilityEpoch: value.capabilityEpoch,
  });
}

function normalizeProviderCallIdentity(identity) {
  if (!isRecord(identity)) throw localError("invalid_call_identity", "Provider call identity must be an object");
  if (identity.provider !== "openai" && identity.provider !== "xai") {
    throw localError("invalid_call_identity", "Provider call identity needs openai or xai");
  }
  if (typeof identity.callId !== "string" ||
      Buffer.byteLength(identity.callId, "utf8") > MCP_MAX_PROVIDER_TOOL_CALL_ID_BYTES ||
      !PROVIDER_CALL_ID.test(identity.callId)) {
    throw localError("invalid_call_identity", "Provider callId is invalid");
  }
  if (typeof identity.responseId !== "string" || !PROVIDER_ITEM_ID.test(identity.responseId)) {
    throw localError("invalid_call_identity", "Provider responseId is required and invalid");
  }
  if (identity.itemId !== undefined && (typeof identity.itemId !== "string" || !PROVIDER_ITEM_ID.test(identity.itemId))) {
    throw localError("invalid_call_identity", "Provider itemId is invalid");
  }
  return deepFreeze({
    provider: identity.provider,
    responseId: identity.responseId,
    callId: identity.callId,
    ...(identity.itemId === undefined ? {} : { itemId: identity.itemId }),
  });
}

function parseRpcResponse(candidate, requestId, capabilityExecutionPossible) {
  const invalidOptions = {
    indeterminate: capabilityExecutionPossible,
    executionStarted: capabilityExecutionPossible,
  };
  if (!isRecord(candidate) || candidate.jsonrpc !== "2.0" || candidate.id !== requestId) {
    throw new AuthorityClientError(
      "rpc_identity_mismatch",
      "MCP response identity did not match the request",
      invalidOptions,
    );
  }
  const hasResult = Object.hasOwn(candidate, "result");
  const hasError = Object.hasOwn(candidate, "error");
  if (hasResult === hasError) {
    throw new AuthorityClientError(
      "invalid_rpc_response",
      "MCP response must contain exactly one of result or error",
      invalidOptions,
    );
  }
  const allowed = hasResult
    ? new Set(["jsonrpc", "id", "result"])
    : new Set(["jsonrpc", "id", "error"]);
  if (Object.keys(candidate).some((key) => !allowed.has(key))) {
    throw new AuthorityClientError("invalid_rpc_response", "MCP response contains unexpected fields", invalidOptions);
  }
  if (hasError) {
    if (!isRecord(candidate.error) || !Number.isSafeInteger(candidate.error.code) || typeof candidate.error.message !== "string") {
      throw new AuthorityClientError("invalid_rpc_error", "MCP response contained an invalid JSON-RPC error", invalidOptions);
    }
    if (Object.keys(candidate.error).some((key) => key !== "code" && key !== "message")) {
      throw new AuthorityClientError("invalid_rpc_error", "MCP JSON-RPC error contains unexpected fields", invalidOptions);
    }
    throw new AuthorityClientError(
      "rpc_error",
      `MCP authority returned JSON-RPC error ${candidate.error.code}`,
      { status: 200, retryable: false, indeterminate: false, executionStarted: false },
    );
  }
  assertStrictJson(candidate.result, "MCP result");
  return candidate.result;
}

function parseInitializeResult(result) {
  if (!isRecord(result) || result.protocolVersion !== MCP_PROTOCOL_VERSION ||
      !isRecord(result.capabilities) || !isRecord(result.capabilities.tools) ||
      !isRecord(result.serverInfo)) {
    throw new AuthorityClientError("invalid_initialize_result", "MCP initialize result has an invalid shape", {
      indeterminate: false,
      executionStarted: false,
    });
  }
  if (Object.keys(result).some((key) => !["protocolVersion", "capabilities", "serverInfo"].includes(key)) ||
      Object.keys(result.capabilities).some((key) => key !== "tools") ||
      Object.keys(result.capabilities.tools).length !== 0 ||
      Object.keys(result.serverInfo).some((key) => key !== "name" && key !== "version") ||
      !boundedProtocolLabel(result.serverInfo.name) || !boundedProtocolLabel(result.serverInfo.version)) {
    throw new AuthorityClientError("invalid_initialize_result", "MCP initialize result contains unsupported fields", {
      indeterminate: false,
      executionStarted: false,
    });
  }
  return deepFreeze({ protocolVersion: result.protocolVersion });
}

function boundedProtocolLabel(value) {
  return typeof value === "string" && value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 1_024 && !/[\u0000-\u001f\u007f]/.test(value);
}

function validateMcpSessionId(value) {
  const match = typeof value === "string" ? value.match(MCP_SESSION_ID) : null;
  if (!match || !canonicalBase64UrlBytes(match[1], 16) || !canonicalBase64UrlBytes(match[2], 32)) {
    throw new AuthorityClientError("invalid_mcp_session", "MCP initialize response omitted a canonical session id", {
      indeterminate: false,
      executionStarted: false,
    });
  }
  return value;
}

function isMcpSessionExpiredResponse(candidate, requestId) {
  return isRecord(candidate) && candidate.jsonrpc === "2.0" && candidate.id === requestId &&
    Object.keys(candidate).length === 3 && Object.hasOwn(candidate, "error") &&
    isRecord(candidate.error) && Object.keys(candidate.error).length === 2 &&
    candidate.error.code === -32002 && candidate.error.message === "invalid MCP session";
}

function canonicalBase64UrlBytes(value, expectedBytes) {
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.byteLength === expectedBytes && decoded.toString("base64url") === value;
  } catch {
    return false;
  }
}

function parseToolCallResult(result, maximumBytes = MAX_RPC_RESPONSE_BYTES) {
  if (!isRecord(result) || !Array.isArray(result.content) || result.content.length !== 1 ||
      typeof result.isError !== "boolean") {
    throw new AuthorityClientError("invalid_tool_result", "MCP tools/call result has an invalid shape", { indeterminate: true });
  }
  for (const item of result.content) {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string" ||
        Object.keys(item).some((key) => key !== "type" && key !== "text")) {
      throw new AuthorityClientError("invalid_tool_result", "MCP tools/call content must contain bounded text items", { indeterminate: true });
    }
  }
  const allowed = new Set(["content", "isError"]);
  if (Object.keys(result).some((key) => !allowed.has(key))) {
    throw new AuthorityClientError("invalid_tool_result", "MCP tools/call result contains unexpected fields", { indeterminate: true });
  }
  let output;
  try {
    output = parseCappedJson(result.content[0].text, {
      maxBytes: maximumBytes,
      maxDepth: 32,
      maxNodes: 16_384,
      maxObjectKeys: 256,
      maxArrayLength: 4_096,
      maxStringBytes: maximumBytes,
      maxKeyBytes: 256,
      maxNumberChars: 128,
    });
  } catch {
    throw new AuthorityClientError("invalid_tool_result", "MCP tools/call text item must contain one strict JSON value", { indeterminate: true });
  }
  const activeCatalogAuthority = validateActiveCatalogEnvelope(output);
  return deepFreeze({ output, isError: result.isError, activeCatalogAuthority });
}

function exactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function invalidActiveCatalogResult() {
  return new AuthorityClientError(
    "invalid_active_catalog_result",
    "MCP tools/call result omitted a valid active capability catalog envelope",
    { indeterminate: true, executionStarted: true },
  );
}

function validateActiveCatalogEnvelope(output) {
  if (!exactKeys(output, ["schema_version", "outcome", "active_capability_catalog"]) ||
      output.schema_version !== 1) {
    throw invalidActiveCatalogResult();
  }
  const catalog = output.active_capability_catalog;
  if (!exactKeys(catalog, [
    "schema_version", "availability", "runtime_digest", "capability_epoch",
    "state_revision", "scope", "active_context", "catalog_digest", "tools",
  ]) || catalog.schema_version !== 1 ||
      (catalog.availability !== "active" && catalog.availability !== "blocked") ||
      typeof catalog.runtime_digest !== "string" || !/^[a-f0-9]{64}$/.test(catalog.runtime_digest) ||
      typeof catalog.catalog_digest !== "string" || !/^[a-f0-9]{64}$/.test(catalog.catalog_digest) ||
      !Number.isSafeInteger(catalog.capability_epoch) || catalog.capability_epoch < 0 ||
      !Number.isSafeInteger(catalog.state_revision) || catalog.state_revision < 0 ||
      !isRecord(catalog.active_context) || !Array.isArray(catalog.tools) || catalog.tools.length > 64 ||
      (catalog.availability === "blocked" && catalog.tools.length !== 0) ||
      Buffer.byteLength(JSON.stringify(catalog), "utf8") > 96 * 1024) {
    throw invalidActiveCatalogResult();
  }
  const scope = catalog.scope;
  if (!exactKeys(scope, ["status", "topic", "step", "attempt"]) ||
      !["routing", "active", "completed", "failed", "direct"].includes(scope.status) ||
      (scope.topic !== null && (typeof scope.topic !== "string" || Buffer.byteLength(scope.topic, "utf8") > 256)) ||
      typeof scope.step !== "string" || scope.step.length < 1 || Buffer.byteLength(scope.step, "utf8") > 512 ||
      !Number.isSafeInteger(scope.attempt) || scope.attempt < 0) {
    throw invalidActiveCatalogResult();
  }
  for (const tool of catalog.tools) validateActiveCatalogTool(tool);
  return deepFreeze({
    catalogDigest: catalog.catalog_digest,
    capabilityEpoch: catalog.capability_epoch,
    availability: catalog.availability,
  });
}

function validateActiveCatalogTool(tool) {
  if (!isRecord(tool)) throw invalidActiveCatalogResult();
  const allowed = new Set([
    "logical_name", "description", "input_schema", "output_schema", "effect", "invocation", "allowed_outcomes",
  ]);
  const required = ["logical_name", "description", "input_schema", "invocation", "allowed_outcomes"];
  if (Object.keys(tool).some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(tool, key)) ||
      typeof tool.logical_name !== "string" || !/^[a-z][a-z0-9_.-]{1,63}$/.test(tool.logical_name) ||
      typeof tool.description !== "string" || tool.description.length < 1 || Buffer.byteLength(tool.description, "utf8") > 2 * 1024 ||
      !isRecord(tool.input_schema) || (tool.output_schema !== undefined && !isRecord(tool.output_schema)) ||
      (tool.effect !== undefined && !["read", "write", "opaque"].includes(tool.effect)) ||
      !Array.isArray(tool.allowed_outcomes) || tool.allowed_outcomes.length < 1 ||
      tool.allowed_outcomes.length !== new Set(tool.allowed_outcomes).size ||
      tool.allowed_outcomes.some((value) => !["completed", "pending", "rejected", "indeterminate"].includes(value))) {
    throw invalidActiveCatalogResult();
  }
  const invocation = tool.invocation;
  if (!isRecord(invocation) || invocation.arguments_from !== "$MODEL_ARGUMENTS") throw invalidActiveCatalogResult();
  if (invocation.mode === "direct") {
    if (!exactKeys(invocation, ["mode", "tool_name", "arguments_from"]) ||
        typeof invocation.tool_name !== "string" || !/^[a-z][a-z0-9_.-]{1,63}$/.test(invocation.tool_name)) {
      throw invalidActiveCatalogResult();
    }
    return;
  }
  if (invocation.mode !== "host_bound_action" ||
      !exactKeys(invocation, ["mode", "tool_name", "arguments_from", "lease_scope_digest", "policy"]) ||
      invocation.tool_name !== tool.logical_name ||
      typeof invocation.lease_scope_digest !== "string" || !/^[a-f0-9]{64}$/.test(invocation.lease_scope_digest) ||
      !isRecord(invocation.policy)) {
    throw invalidActiveCatalogResult();
  }
  const policyKeys = Object.keys(invocation.policy);
  if (policyKeys.some((key) => key !== "idempotency" && key !== "max_calls") ||
      !Object.hasOwn(invocation.policy, "idempotency") ||
      !["none", "per_step", "per_arguments", "per_call", "per_call_arguments"].includes(invocation.policy.idempotency) ||
      (invocation.policy.max_calls !== undefined &&
        (!Number.isInteger(invocation.policy.max_calls) || invocation.policy.max_calls < 1 || invocation.policy.max_calls > 100))) {
    throw invalidActiveCatalogResult();
  }
}

function sameOriginMcpEndpoint(appOrigin, endpoint, allowInsecureLocalhostForTests) {
  if (typeof appOrigin !== "string" || Buffer.byteLength(appOrigin, "utf8") > 2_048) {
    throw localError("invalid_origin", "appOrigin must be a bounded URL");
  }
  if (endpoint !== undefined && (typeof endpoint !== "string" || Buffer.byteLength(endpoint, "utf8") > 2_048)) {
    throw localError("invalid_endpoint", "MCP endpoint must be a bounded string");
  }
  let origin;
  try { origin = new URL(appOrigin); }
  catch { throw localError("invalid_origin", "appOrigin is invalid"); }
  if (origin.username || origin.password || origin.hash || origin.search || origin.pathname !== "/") {
    throw localError("invalid_origin", "appOrigin must be an origin without credentials, path, query, or fragment");
  }
  if (origin.protocol !== "https:" && !(allowInsecureLocalhostForTests && origin.protocol === "http:" && isLoopback(origin.hostname))) {
    throw localError("invalid_origin", "Authority calls require HTTPS except explicit loopback tests");
  }
  let target;
  try { target = new URL(endpoint ?? "/api/mcp", origin); }
  catch { throw localError("invalid_endpoint", "MCP endpoint is invalid"); }
  if (target.origin !== origin.origin || target.pathname !== "/api/mcp" || target.search || target.hash || target.username || target.password) {
    throw localError("invalid_endpoint", "MCP endpoint must be the same-origin /api/mcp route");
  }
  return target.toString();
}

function validateScopeToken(value) {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > MAX_SCOPE_BYTES ||
      /[\s,\u0000-\u001f\u007f]/.test(value) || /^Bearer\b/i.test(value)) {
    throw localError("invalid_scope", "scopeToken is not a bounded bearer credential");
  }
  // Catch the common accidental wiring errors without trying to infer every
  // provider's secret format. Provider keys have no place in this client.
  if (/^(?:sk-(?:proj-|svcacct-)?|xai-|AIza)/.test(value)) {
    throw localError("provider_key_refused", "AuthorityClient refuses provider API keys");
  }
  return value;
}

async function readOptionalBodyCapped(response, maximumBytes, signal, timeoutMs, capabilityExecutionPossible) {
  const advertised = response.headers.get("content-length");
  if (!response.body) {
    if (advertised !== null && advertised !== "0") {
      throw new AuthorityClientError("invalid_response", "MCP response body length was inconsistent", {
        indeterminate: capabilityExecutionPossible,
        executionStarted: capabilityExecutionPossible,
      });
    }
    return new Uint8Array();
  }
  return readBodyCapped(response, maximumBytes, signal, timeoutMs, capabilityExecutionPossible);
}

async function readBodyCapped(response, maximumBytes, signal, timeoutMs, capabilityExecutionPossible = true) {
  const advertised = response.headers.get("content-length");
  if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > maximumBytes)) {
    cancelBody(response);
    throw new AuthorityClientError("response_too_large", `MCP response exceeds ${maximumBytes} bytes`, {
      indeterminate: capabilityExecutionPossible,
      executionStarted: capabilityExecutionPossible,
    });
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new AuthorityClientError("invalid_response", "MCP response has no readable body", {
      indeterminate: capabilityExecutionPossible,
      executionStarted: capabilityExecutionPossible,
    });
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await raceWithAbort(reader.read(), signal);
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("non-byte response body");
      total += value.byteLength;
      if (total > maximumBytes) {
        cancelReader(reader);
        throw new AuthorityClientError("response_too_large", `MCP response exceeds ${maximumBytes} bytes`, {
          indeterminate: capabilityExecutionPossible,
          executionStarted: capabilityExecutionPossible,
        });
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof AuthorityClientError) throw error;
    if (signal.aborted) {
      cancelReader(reader);
      throw new AuthorityClientError("timeout", `MCP request timed out after ${timeoutMs} ms`, {
        retryable: true,
        indeterminate: capabilityExecutionPossible,
        executionStarted: capabilityExecutionPossible,
        cause: error,
      });
    }
    throw new AuthorityClientError("response_read_failed", "MCP response failed while reading", {
      retryable: true,
      indeterminate: capabilityExecutionPossible,
      executionStarted: capabilityExecutionPossible,
      cause: error,
    });
  } finally {
    try { reader.releaseLock(); }
    catch {}
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function cancelBody(response) {
  try { void Promise.resolve(response.body?.cancel?.()).catch(() => undefined); }
  catch {}
}

function cancelReader(reader) {
  try { void Promise.resolve(reader.cancel()).catch(() => undefined); }
  catch {}
}

function isResponseLike(value) {
  return value !== null && typeof value === "object" &&
    typeof value.ok === "boolean" && Number.isInteger(value.status) &&
    value.headers && typeof value.headers.get === "function";
}

function assertStrictJson(value, path, ancestors = new WeakSet(), depth = 0, budget = undefined) {
  const state = budget ?? { nodes: 0, bytes: 0 };
  state.nodes += 1;
  if (state.nodes > MAX_INPUT_NODES) throw localError("json_too_complex", `${path} exceeds ${MAX_INPUT_NODES} values`);
  if (depth > MAX_INPUT_DEPTH) throw localError("json_too_deep", `${path} exceeds ${MAX_INPUT_DEPTH} levels`);
  if (value === null || typeof value === "boolean") {
    addInputBytes(state, value === null ? 4 : value ? 4 : 5, path);
    return;
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_INPUT_STRING_BYTES) {
      throw localError("request_too_large", `${path} contains an oversized string`);
    }
    addInputBytes(state, Buffer.byteLength(JSON.stringify(value), "utf8"), path);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw localError("invalid_json", `${path} contains a non-finite number`);
    addInputBytes(state, Buffer.byteLength(JSON.stringify(value), "utf8"), path);
    return;
  }
  if (typeof value !== "object") throw localError("invalid_json", `${path} contains a non-JSON value`);
  if (ancestors.has(value)) throw localError("invalid_json", `${path} contains a cycle`);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw localError("invalid_json", `${path} contains a non-JSON object`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    if (value.length > MAX_INPUT_ARRAY_LENGTH) throw localError("json_too_complex", `${path} array is too long`);
    const enumerable = Object.keys(value);
    if (enumerable.length !== value.length || enumerable.some((key, index) => key !== String(index))) {
      throw localError("invalid_json", `${path} must be a dense JSON array without extra properties`);
    }
    if (Reflect.ownKeys(value).some((key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key)))) {
      throw localError("invalid_json", `${path} contains a non-JSON array property`);
    }
    addInputBytes(state, 2 + Math.max(0, value.length - 1), path);
    for (let index = 0; index < value.length; index += 1) {
      assertStrictJson(value[index], `${path}[${index}]`, ancestors, depth + 1, state);
    }
  } else {
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_INPUT_OBJECT_KEYS) throw localError("json_too_complex", `${path} object has too many keys`);
    addInputBytes(state, 2 + Math.max(0, keys.length - 1), path);
    for (const key of keys) {
      if (typeof key !== "string") throw localError("invalid_json", `${path} contains a symbol key`);
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        throw localError("unsafe_json_key", `${path} contains unsafe key ${key}`);
      }
      if (Buffer.byteLength(key, "utf8") > MAX_INPUT_KEY_BYTES) {
        throw localError("invalid_json", `${path} contains an oversized key`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw localError("invalid_json", `${path}.${key} must be an enumerable data property`);
      }
      addInputBytes(state, Buffer.byteLength(JSON.stringify(key), "utf8") + 1, path);
      assertStrictJson(descriptor.value, `${path}.${key}`, ancestors, depth + 1, state);
    }
  }
  ancestors.delete(value);
}

function addInputBytes(state, bytes, path) {
  state.bytes += bytes;
  if (!Number.isSafeInteger(state.bytes) || state.bytes > MAX_RPC_REQUEST_BYTES) {
    throw localError("request_too_large", `${path} exceeds the bounded request budget`);
  }
}

function raceWithAbort(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("authority_timeout"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("authority_timeout"));
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

function deadlineController(timeoutMs, reason) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(reason)), timeoutMs);
  return {
    controller,
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}

function linkAbort(source, target) {
  if (source.aborted) {
    target.abort(source.reason ?? new Error("authority_aborted"));
    return () => {};
  }
  const onAbort = () => target.abort(source.reason ?? new Error("authority_aborted"));
  source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}

function compactAuthorityError(error) {
  return new AuthorityClientError(error.code, String(error.message).slice(0, 2_000), {
    retryable: error.retryable === true,
    indeterminate: error.indeterminate === true,
    status: error.status,
    executionStarted: error.executionStarted,
  });
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update("hacc/authority-call/v1\0", "utf8").update(value, "utf8").digest("hex");
}

function boundedPositiveInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw localError("invalid_options", `${label} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(root) {
  const pending = [root];
  const seen = new WeakSet();
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    for (const child of Object.values(value)) if (child && typeof child === "object") pending.push(child);
    Object.freeze(value);
  }
  return root;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeMessage(error) {
  return (error instanceof Error ? error.message : String(error ?? "Unknown authority error")).slice(0, 2_000);
}

function localError(code, message) {
  return new AuthorityClientError(code, message, {
    retryable: false,
    indeterminate: false,
    executionStarted: false,
  });
}
