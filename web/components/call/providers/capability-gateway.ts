import {
  BROWSER_REALTIME_LIMITS,
  readBoundedResponseText,
  utf8Bytes,
} from "./types";
import type { ToolProxyRotation } from "@/lib/realtime/types";

export const CAPABILITY_GATEWAY_FUNCTION_NAME = "capability_gateway" as const;
export const MCP_PROVIDER_TOOL_CALL_ID_META_KEY = "hacc/provider_tool_call_id" as const;
export const PROVIDER_PROVENANCE_META_KEY = "com.harsha.callcenter/provider-provenance" as const;
export const ACTIVE_CATALOG_META_KEY = "com.harsha.callcenter/active-catalog" as const;
export const PROVIDER_CONNECTION_META_KEY = "com.harsha.callcenter/provider-connection" as const;

const MCP_PROTOCOL_VERSION = "2025-11-25";
const MCP_SESSION_ID = /^hacc\.v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
const MCP_TOOL_NAME = /^[a-z][a-z0-9_.-]{1,63}$/;
const MAX_MCP_REQUEST_BYTES = 256 * 1024;
const MAX_NATIVE_CALL_ID_BYTES = 256;
const MAX_NATIVE_ID_BYTES = 512;
const MAX_TRACKED_CALL_IDENTITIES = 10_000;
const MAX_CALLS_PER_BATCH = 64;
const MAX_QUEUED_BATCHES = 8;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ROTATION_RESPONSE_BYTES = 32 * 1024;
const CAPABILITY_TTL_MS = 30 * 60_000;
const CAPABILITY_OVERLAP_MS = 5 * 60_000;
const CAPABILITY_REFRESH_RETRY_MIN_MS = 1_000;
const CAPABILITY_REFRESH_RETRY_MAX_MS = 30_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ACTIVE_CATALOG_BYTES = 96 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const PROVIDER_CONNECTION_ID = /^hacc\.pc\.v2\.[a-f0-9]{64}\.[A-Za-z0-9_-]{43}$/;
const ACTIVE_OUTCOMES = new Set(["completed", "pending", "rejected", "indeterminate"]);
const FLOW_STATUSES = new Set(["routing", "active", "completed", "failed", "direct"]);
const IDEMPOTENCY_POLICIES = new Set(["none", "per_step", "per_arguments", "per_call", "per_call_arguments"]);

type BrowserGatewayProvider = "openai" | "xai" | "gemini";

type JsonRpcId = string;

export type BrowserCapabilityGatewayCall = Readonly<{
  functionName: string;
  nativeCallId: string;
  nativeResponseId: string;
  nativeItemId?: string;
  terminalEventId?: string;
  terminalWireType: string;
  arguments: unknown;
}>;

export type BrowserCapabilityGatewayResult = Readonly<{
  nativeCallId: string;
  output: unknown;
  isError: boolean;
}>;

export type BrowserCapabilityGatewayOptions = Readonly<{
  provider: BrowserGatewayProvider;
  url: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  randomId?: () => string;
  expectedOrigin?: string;
  activeCatalogDigest: string;
  activeCatalogEpoch: number;
  activeRuntimeDigest: string;
  activeStateRevision: number;
  rotation: ToolProxyRotation;
  now?: () => number;
}>;

type ActiveCatalogAuthority = Readonly<{
  catalog_digest: string;
  capability_epoch: number;
}>;

type VerifiedActiveCatalog = Readonly<{
  availability: "active" | "blocked";
  catalog_digest: string;
  capability_epoch: number;
  runtime_digest: string;
  state_revision: number;
}>;

export type BrowserCapabilityGatewayDrainResult = Readonly<{
  settledNativeCallIds: readonly string[];
  unresolvedNativeCallIds: readonly string[];
}>;

class GatewayProtocolError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly rpcCode?: number,
  ) {
    super(message);
    this.name = "GatewayProtocolError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function own(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function exactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => own(record, key))
    && Object.keys(record).every((key) => allowed.has(key));
}

function assertStrictJson(
  value: unknown,
  path: string,
  ancestors = new WeakSet<object>(),
  depth = 0,
): void {
  if (depth > 64) throw new Error(`${path} exceeds the maximum JSON depth`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`);
    return;
  }
  if (typeof value !== "object") throw new Error(`${path} contains a non-JSON value`);
  if (ancestors.has(value)) throw new Error(`${path} contains a cycle`);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} contains a non-JSON object`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertStrictJson(entry, `${path}[${index}]`, ancestors, depth + 1));
  } else {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        throw new Error(`${path} contains an unsafe object key`);
      }
      assertStrictJson(entry, `${path}.${key}`, ancestors, depth + 1);
    }
  }
  ancestors.delete(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function deepFreezeJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreezeJson(child, seen);
  return Object.freeze(value);
}

function boundedInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function boundedString(value: unknown, maximumBytes: number, allowNull = false): boolean {
  return (allowNull && value === null)
    || (typeof value === "string" && !!value && utf8Bytes(value) <= maximumBytes
      && !/[\u0000-\u001f\u007f]/.test(value));
}

function validateCatalogTool(value: unknown, index: number, priorName: string | null): string {
  if (!isRecord(value) || !exactKeys(
    value,
    ["logical_name", "description", "input_schema", "invocation", "allowed_outcomes"],
    ["output_schema", "effect"],
  )) throw new GatewayProtocolError(`active capability catalog tool ${index} is invalid`);
  if (typeof value.logical_name !== "string" || !MCP_TOOL_NAME.test(value.logical_name)
    || (priorName !== null && value.logical_name <= priorName)
    || !boundedString(value.description, 2 * 1024)
    || !isRecord(value.input_schema)
    || (value.output_schema !== undefined && !isRecord(value.output_schema))
    || (value.effect !== undefined && !["read", "write", "opaque"].includes(String(value.effect)))) {
    throw new GatewayProtocolError(`active capability catalog tool ${index} is invalid`);
  }
  if (!Array.isArray(value.allowed_outcomes) || value.allowed_outcomes.length < 1
    || value.allowed_outcomes.length > ACTIVE_OUTCOMES.size
    || new Set(value.allowed_outcomes).size !== value.allowed_outcomes.length
    || value.allowed_outcomes.some((outcome) => typeof outcome !== "string" || !ACTIVE_OUTCOMES.has(outcome))) {
    throw new GatewayProtocolError(`active capability catalog tool ${index} outcomes are invalid`);
  }
  const invocation = value.invocation;
  if (!isRecord(invocation) || invocation.arguments_from !== "$MODEL_ARGUMENTS"
    || typeof invocation.tool_name !== "string" || !MCP_TOOL_NAME.test(invocation.tool_name)) {
    throw new GatewayProtocolError(`active capability catalog tool ${index} invocation is invalid`);
  }
  if (invocation.mode === "direct") {
    if (!exactKeys(invocation, ["mode", "tool_name", "arguments_from"])) {
      throw new GatewayProtocolError(`active capability catalog tool ${index} direct invocation is invalid`);
    }
  } else if (invocation.mode === "host_bound_action") {
    if (!exactKeys(invocation, ["mode", "tool_name", "arguments_from", "lease_scope_digest", "policy"])
      || typeof invocation.lease_scope_digest !== "string" || !SHA256.test(invocation.lease_scope_digest)
      || !isRecord(invocation.policy)
      || !exactKeys(invocation.policy, ["idempotency"], ["max_calls"])
      || typeof invocation.policy.idempotency !== "string"
      || !IDEMPOTENCY_POLICIES.has(invocation.policy.idempotency)
      || (invocation.policy.max_calls !== undefined
        && (!Number.isSafeInteger(invocation.policy.max_calls)
          || Number(invocation.policy.max_calls) < 1 || Number(invocation.policy.max_calls) > 100))) {
      throw new GatewayProtocolError(`active capability catalog tool ${index} action invocation is invalid`);
    }
  } else {
    throw new GatewayProtocolError(`active capability catalog tool ${index} invocation mode is invalid`);
  }
  return value.logical_name;
}

async function verifiedResultEnvelope(
  value: unknown,
  pinnedRuntimeDigest: string,
  minimum: Readonly<{ capability_epoch: number; state_revision: number }>,
  isError?: boolean,
): Promise<VerifiedActiveCatalog> {
  if (!isRecord(value) || !exactKeys(value, ["schema_version", "outcome", "active_capability_catalog"])
    || value.schema_version !== 1 || !isRecord(value.active_capability_catalog)) {
    throw new GatewayProtocolError("tool gateway result omitted the active capability envelope");
  }
  const outcomeHasError = isRecord(value.outcome) && own(value.outcome, "error");
  if (isError !== undefined && outcomeHasError !== isError) {
    throw new GatewayProtocolError("tool gateway result error bit contradicted its outcome envelope");
  }
  const catalog = value.active_capability_catalog;
  if (!exactKeys(catalog, [
    "schema_version", "availability", "runtime_digest", "capability_epoch", "state_revision",
    "scope", "active_context", "catalog_digest", "tools",
  ]) || catalog.schema_version !== 1
    || (catalog.availability !== "active" && catalog.availability !== "blocked")
    || typeof catalog.runtime_digest !== "string" || !SHA256.test(catalog.runtime_digest)
    || !boundedInteger(catalog.capability_epoch) || !boundedInteger(catalog.state_revision)
    || typeof catalog.catalog_digest !== "string" || !SHA256.test(catalog.catalog_digest)
    || !isRecord(catalog.scope) || !exactKeys(catalog.scope, ["status", "topic", "step", "attempt"])
    || typeof catalog.scope.status !== "string" || !FLOW_STATUSES.has(catalog.scope.status)
    || !boundedString(catalog.scope.topic, 256, true) || !boundedString(catalog.scope.step, 512)
    || !boundedInteger(catalog.scope.attempt)
    || !isRecord(catalog.active_context)
    || !Array.isArray(catalog.tools) || catalog.tools.length > 64
    || (catalog.availability === "blocked" && catalog.tools.length !== 0)) {
    throw new GatewayProtocolError("tool gateway returned an invalid active capability catalog");
  }
  let priorName: string | null = null;
  for (let index = 0; index < catalog.tools.length; index += 1) {
    priorName = validateCatalogTool(catalog.tools[index], index, priorName);
  }
  if (utf8Bytes(JSON.stringify(catalog)) > MAX_ACTIVE_CATALOG_BYTES) {
    throw new GatewayProtocolError("tool gateway active capability catalog exceeded 96 KiB");
  }
  if (catalog.runtime_digest !== pinnedRuntimeDigest) {
    throw new GatewayProtocolError("tool gateway active capability catalog changed the admitted runtime");
  }
  if (catalog.capability_epoch < minimum.capability_epoch
    || catalog.state_revision < minimum.state_revision) {
    throw new GatewayProtocolError("tool gateway active capability catalog rolled authority backward");
  }
  const semanticCatalog = {
    schema_version: catalog.schema_version,
    availability: catalog.availability,
    runtime_digest: catalog.runtime_digest,
    capability_epoch: catalog.capability_epoch,
    state_revision: catalog.state_revision,
    scope: catalog.scope,
    active_context: catalog.active_context,
    tools: catalog.tools,
  };
  if (await sha256(canonicalJson(semanticCatalog)) !== catalog.catalog_digest) {
    throw new GatewayProtocolError("tool gateway active capability catalog digest mismatch");
  }
  return Object.freeze({
    availability: catalog.availability,
    catalog_digest: catalog.catalog_digest,
    capability_epoch: catalog.capability_epoch,
    runtime_digest: catalog.runtime_digest,
    state_revision: catalog.state_revision,
  });
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function boundedOpaqueId(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== "string" || !value || value !== value.trim()
    || utf8Bytes(value) > maximumBytes || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be a canonical non-empty string of at most ${maximumBytes} UTF-8 bytes`);
  }
  return value;
}

function boundedSessionId(value: unknown): string {
  if (typeof value !== "string" || !MCP_SESSION_ID.test(value)) {
    throw new GatewayProtocolError("tool gateway did not issue a valid MCP session id");
  }
  return value;
}

function validatedProxyUrl(value: string, expectedOrigin?: string): string {
  let parsed: URL;
  let origin: URL;
  try {
    const ambientOrigin = expectedOrigin ?? globalThis.location?.origin;
    if (!ambientOrigin || ambientOrigin === "null") throw new Error("missing browser origin");
    origin = new URL(ambientOrigin);
    parsed = new URL(value, origin);
  } catch {
    throw new Error("tool gateway URL or browser origin is invalid");
  }
  if ((origin.protocol !== "https:" && origin.protocol !== "http:")
    || parsed.origin !== origin.origin
    || parsed.protocol !== origin.protocol
    || parsed.username || parsed.password || parsed.search || parsed.hash
    || parsed.pathname !== "/api/mcp") {
    throw new Error("tool gateway must be the exact same-origin /api/mcp endpoint");
  }
  return parsed.href;
}

function validatedRotationUrl(value: string, expectedOrigin?: string): string {
  let parsed: URL;
  let origin: URL;
  try {
    const ambientOrigin = expectedOrigin ?? globalThis.location?.origin;
    if (!ambientOrigin || ambientOrigin === "null") throw new Error("missing browser origin");
    origin = new URL(ambientOrigin);
    parsed = new URL(value, origin);
  } catch {
    throw new Error("tool capability rotation URL or browser origin is invalid");
  }
  if ((origin.protocol !== "https:" && origin.protocol !== "http:")
    || parsed.origin !== origin.origin || parsed.protocol !== origin.protocol
    || parsed.username || parsed.password || parsed.search || parsed.hash
    || parsed.pathname !== "/api/voice/capabilities/rotate") {
    throw new Error("tool capability rotation must use the exact same-origin rotation endpoint");
  }
  return parsed.href;
}

function canonicalIsoMillis(value: unknown, label: string): number {
  if (typeof value !== "string") throw new Error(`${label} must be a canonical ISO timestamp`);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return time;
}

function validatedToken(value: string): string {
  if (typeof value !== "string" || value.length < 80 || value.length > 4_096 || /\s|[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("tool gateway capability token is invalid");
  }
  return value;
}

function safeDiagnostic(error: unknown): string {
  return (error instanceof Error ? error.message : "tool gateway failed").slice(0, 2_000);
}

export class BrowserCapabilityGateway {
  private readonly provider: BrowserGatewayProvider;
  private readonly url: string;
  private token: string;
  private renewalToken: string;
  private readonly rotationUrl: string;
  private readonly rotationCallId: string;
  private rotationGeneration: number;
  private refreshAfterMs: number;
  private expiresAtMs: number;
  private readonly now: () => number;
  private rotationPromise: Promise<void> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshRetryCount = 0;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly randomId: () => string;
  private providerConnectionNonce: string;
  private providerConnectionId: string | null = null;
  private readonly abortControllers = new Set<AbortController>();
  private readonly callFingerprints = new Map<string, string>();
  private readonly inFlightCalls = new Map<string, Promise<BrowserCapabilityGatewayResult>>();
  private readonly completedCalls = new Map<string, BrowserCapabilityGatewayResult>();
  private sessionId: string | null = null;
  private initializePromise: Promise<void> | null = null;
  private batchTail: Promise<void> = Promise.resolve();
  private queuedBatches = 0;
  private activeCatalogAuthority: ActiveCatalogAuthority;
  private readonly activeRuntimeDigest: string;
  private activeStateRevision: number;
  private catalogBlocked = false;
  private acceptingCalls = true;
  private stopped = false;
  private drainPromise: Promise<BrowserCapabilityGatewayDrainResult> | null = null;

  constructor(options: BrowserCapabilityGatewayOptions) {
    this.provider = options.provider;
    this.url = validatedProxyUrl(options.url, options.expectedOrigin);
    this.token = validatedToken(options.token);
    if (!isRecord(options.rotation) || !UUID.test(options.rotation.callId)
      || !Number.isSafeInteger(options.rotation.rotation) || options.rotation.rotation < 0
      || options.rotation.rotation > 1_000_000) {
      throw new Error("tool capability rotation binding is invalid");
    }
    this.rotationUrl = validatedRotationUrl(options.rotation.endpoint, options.expectedOrigin);
    this.rotationCallId = options.rotation.callId;
    this.rotationGeneration = options.rotation.rotation;
    this.renewalToken = validatedToken(options.rotation.renewalToken);
    this.refreshAfterMs = canonicalIsoMillis(options.rotation.refreshAfter, "tool capability refresh_after");
    this.expiresAtMs = canonicalIsoMillis(options.rotation.expiresAt, "tool capability expires_at");
    if (this.expiresAtMs - this.refreshAfterMs !== CAPABILITY_OVERLAP_MS
      || this.refreshAfterMs < 0 || this.expiresAtMs <= this.refreshAfterMs) {
      throw new Error("tool capability rotation window is invalid");
    }
    if (this.renewalToken === this.token) throw new Error("tool and renewal capabilities must be distinct");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) {
      throw new Error("tool gateway timeout must be between 1 and 60000 milliseconds");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.randomId = options.randomId ?? (() => crypto.randomUUID());
    // One gateway instance is owned by one physical provider transport. MCP
    // sessions and bearer capabilities can rotate beneath it, but a provider
    // reconnect constructs a fresh gateway and therefore a fresh 256-bit nonce.
    const providerConnectionNonceBytes = new Uint8Array(32);
    crypto.getRandomValues(providerConnectionNonceBytes);
    this.providerConnectionNonce = [...providerConnectionNonceBytes]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    this.now = options.now ?? Date.now;
    if (typeof this.now !== "function" || !Number.isFinite(this.now())) {
      throw new Error("tool capability rotation clock is invalid");
    }
    if (!SHA256.test(options.activeCatalogDigest) || !boundedInteger(options.activeCatalogEpoch)
      || !SHA256.test(options.activeRuntimeDigest) || !boundedInteger(options.activeStateRevision)) {
      throw new Error("initial active capability catalog authority is invalid");
    }
    this.activeRuntimeDigest = options.activeRuntimeDigest;
    this.activeStateRevision = options.activeStateRevision;
    this.activeCatalogAuthority = Object.freeze({
      catalog_digest: options.activeCatalogDigest,
      capability_epoch: options.activeCatalogEpoch,
    });
  }

  async initialize(force = false): Promise<void> {
    this.assertRunning();
    await this.ensureFreshCapability();
    if (force) this.sessionId = null;
    if (this.sessionId) {
      this.scheduleCapabilityRefresh();
      return;
    }
    if (this.initializePromise) return this.initializePromise;
    const pending = this.bootstrap();
    this.initializePromise = pending;
    try {
      await pending;
      this.scheduleCapabilityRefresh();
    } finally {
      if (this.initializePromise === pending) this.initializePromise = null;
    }
  }

  executeBatch(
    calls: readonly BrowserCapabilityGatewayCall[],
  ): Promise<readonly BrowserCapabilityGatewayResult[]> {
    this.assertRunning();
    if (!this.acceptingCalls) {
      return Promise.reject(new Error("tool gateway client is draining"));
    }
    if (this.catalogBlocked) {
      return Promise.reject(new Error("active capability catalog is blocked; reconnect before calling another tool"));
    }
    if (!Array.isArray(calls) || calls.length < 1 || calls.length > MAX_CALLS_PER_BATCH) {
      return Promise.reject(new Error(`capability gateway batches must contain 1-${MAX_CALLS_PER_BATCH} calls`));
    }
    if (this.queuedBatches >= MAX_QUEUED_BATCHES) {
      return Promise.reject(new Error("capability gateway batch queue is full"));
    }
    this.queuedBatches += 1;
    // Capture when the provider terminal batch arrives, not when it eventually
    // reaches the queue. A later batch cannot inherit authority learned only
    // after the model had already produced it.
    const authority = this.activeCatalogAuthority;
    const execute = this.batchTail.then(() => this.executeBatchSerial(calls, authority));
    this.batchTail = execute.then(() => undefined, () => undefined);
    return execute.finally(() => { this.queuedBatches -= 1; });
  }

  close(): void {
    if (this.stopped) return;
    this.acceptingCalls = false;
    this.finalizeClose();
  }

  drainAndClose(timeoutMs: number): Promise<BrowserCapabilityGatewayDrainResult> {
    if (this.drainPromise) return this.drainPromise;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 10_000) {
      return Promise.reject(new Error("tool gateway shutdown drain must be between 0 and 10000 milliseconds"));
    }
    this.acceptingCalls = false;
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    const identities = Object.freeze([...this.inFlightCalls.keys()].sort());
    const drain = this.performDrain(identities, timeoutMs);
    this.drainPromise = drain;
    return drain;
  }

  private async performDrain(
    identities: readonly string[],
    timeoutMs: number,
  ): Promise<BrowserCapabilityGatewayDrainResult> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      if (identities.length > 0 && timeoutMs > 0) {
        const pending = Promise.allSettled(
          identities.map((identity) => this.inFlightCalls.get(identity) ?? Promise.resolve()),
        ).then(() => undefined);
        const deadline = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        });
        await Promise.race([pending, deadline]);
      }
      const settledNativeCallIds = identities.filter((identity) => this.completedCalls.has(identity));
      const settled = new Set(settledNativeCallIds);
      return Object.freeze({
        settledNativeCallIds: Object.freeze(settledNativeCallIds),
        unresolvedNativeCallIds: Object.freeze(identities.filter((identity) => !settled.has(identity))),
      });
    } finally {
      if (timer !== null) clearTimeout(timer);
      this.finalizeClose();
    }
  }

  private finalizeClose(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.sessionId = null;
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    for (const controller of this.abortControllers) controller.abort();
    this.abortControllers.clear();
    this.inFlightCalls.clear();
    this.completedCalls.clear();
    this.providerConnectionId = null;
    this.providerConnectionNonce = "";
    this.renewalToken = "";
    this.token = "";
  }

  private scheduleCapabilityRefresh(delayOverrideMs?: number): void {
    if (this.stopped) return;
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    const now = this.now();
    if (!Number.isFinite(now) || now < 0 || now >= this.expiresAtMs) {
      this.refreshTimer = null;
      return;
    }
    const delay = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(0, delayOverrideMs ?? this.refreshAfterMs - now)
    );
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.runScheduledRefresh();
    }, delay);
    // Do not keep Node test/server processes alive solely for a browser-only refresh timer.
    const timer = this.refreshTimer as ReturnType<typeof setTimeout> & { unref?: () => void };
    timer.unref?.();
  }

  private async runScheduledRefresh(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.ensureFreshCapability();
      this.refreshRetryCount = 0;
      this.scheduleCapabilityRefresh();
    } catch {
      if (this.stopped) return;
      const now = this.now();
      if (!Number.isFinite(now) || now >= this.expiresAtMs) return;
      this.refreshRetryCount += 1;
      const retryDelay = Math.min(
        CAPABILITY_REFRESH_RETRY_MAX_MS,
        CAPABILITY_REFRESH_RETRY_MIN_MS * 2 ** Math.min(this.refreshRetryCount - 1, 5),
        Math.max(0, this.expiresAtMs - now - 1)
      );
      this.scheduleCapabilityRefresh(retryDelay);
    }
  }

  private async ensureFreshCapability(): Promise<void> {
    this.assertRunning();
    const now = this.now();
    if (!Number.isFinite(now) || now < 0) throw new Error("tool capability rotation clock is invalid");
    if (now < this.refreshAfterMs) return;
    if (now >= this.expiresAtMs) {
      throw new GatewayProtocolError("tool and renewal capabilities expired before rotation completed", 401);
    }
    if (this.rotationPromise) return this.rotationPromise;
    const pending = this.rotateCapability();
    this.rotationPromise = pending;
    try {
      await pending;
    } finally {
      if (this.rotationPromise === pending) this.rotationPromise = null;
    }
  }

  private async rotateCapability(): Promise<void> {
    const requestedGeneration = this.rotationGeneration + 1;
    if (!Number.isSafeInteger(requestedGeneration) || requestedGeneration > 1_000_000) {
      throw new GatewayProtocolError("tool capability rotation limit exceeded");
    }
    const idempotencyKey = `${this.rotationCallId}:${requestedGeneration}`;
    const requestBody = JSON.stringify({
      schema_version: 1,
      call_id: this.rotationCallId,
      rotation: requestedGeneration,
    });
    const controller = new AbortController();
    this.abortControllers.add(controller);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new GatewayProtocolError("tool capability rotation timed out"));
        }, this.timeoutMs);
      });
      const operation = (async () => {
        const response = await this.fetchImpl(this.rotationUrl, {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.renewalToken}`,
            "Idempotency-Key": idempotencyKey,
          },
          body: requestBody,
          redirect: "error",
          signal: controller.signal,
        });
        if (response.redirected) throw new GatewayProtocolError("tool capability rotation redirects are forbidden");
        const text = await readBoundedResponseText(
          response,
          MAX_ROTATION_RESPONSE_BYTES,
          "tool capability rotation response",
        );
        if (!response.ok) {
          throw new GatewayProtocolError(`tool capability rotation HTTP ${response.status}`, response.status);
        }
        return text;
      })();
      const text = await Promise.race([operation, deadline]);
      let value: unknown;
      try { value = JSON.parse(text); } catch {
        throw new GatewayProtocolError("tool capability rotation returned malformed JSON");
      }
      if (!isRecord(value) || !exactKeys(value, [
        "schema_version", "call_id", "rotation", "refresh_after", "expires_at",
        "mcp_capability", "renewal_capability",
      ]) || value.schema_version !== 1 || value.call_id !== this.rotationCallId
        || value.rotation !== requestedGeneration || !isRecord(value.mcp_capability)
        || !isRecord(value.renewal_capability)) {
        throw new GatewayProtocolError("tool capability rotation response binding is invalid");
      }
      const mcp = value.mcp_capability;
      const renewal = value.renewal_capability;
      if (!exactKeys(mcp, ["token", "expires_at", "audience", "purpose"])
        || !exactKeys(renewal, ["token", "expires_at", "audience", "purpose"])
        || mcp.audience !== "mcp" || mcp.purpose !== "tool-invocation"
        || renewal.audience !== "browser_refresh" || renewal.purpose !== "capability_rotation"
        || mcp.expires_at !== value.expires_at || renewal.expires_at !== value.expires_at) {
        throw new GatewayProtocolError("tool capability rotation response capabilities are invalid");
      }
      const nextToken = validatedToken(String(mcp.token ?? ""));
      const nextRenewalToken = validatedToken(String(renewal.token ?? ""));
      if (nextToken === nextRenewalToken || nextToken === this.token || nextRenewalToken === this.renewalToken) {
        throw new GatewayProtocolError("tool capability rotation did not issue fresh distinct capabilities");
      }
      const refreshAfterMs = canonicalIsoMillis(value.refresh_after, "tool capability refresh_after");
      const expiresAtMs = canonicalIsoMillis(value.expires_at, "tool capability expires_at");
      const receivedAt = this.now();
      if (!Number.isFinite(receivedAt) || expiresAtMs - refreshAfterMs !== CAPABILITY_OVERLAP_MS
        || expiresAtMs <= receivedAt || expiresAtMs - receivedAt > CAPABILITY_TTL_MS + 10_000
        || refreshAfterMs <= receivedAt) {
        throw new GatewayProtocolError("tool capability rotation response window is invalid");
      }
      this.assertRunning();
      // Publish the complete new generation atomically. Existing MCP sessions
      // are capability-JTI-bound, so the next request must initialize anew.
      this.token = nextToken;
      this.renewalToken = nextRenewalToken;
      this.rotationGeneration = requestedGeneration;
      this.refreshAfterMs = refreshAfterMs;
      this.expiresAtMs = expiresAtMs;
      this.sessionId = null;
      this.refreshRetryCount = 0;
    } catch (error) {
      if (controller.signal.aborted && this.stopped) {
        throw new GatewayProtocolError("tool gateway client was stopped");
      }
      if (error instanceof GatewayProtocolError) throw error;
      throw new GatewayProtocolError(safeDiagnostic(error));
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      this.abortControllers.delete(controller);
    }
  }

  private async bootstrap(): Promise<void> {
    const requestId = this.boundedRequestId(this.randomId());
    const initialized = await this.rpc(requestId, "initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "hacc-browser-realtime", version: "1.0.0" },
      _meta: {
        [PROVIDER_CONNECTION_META_KEY]: {
          schemaVersion: 2,
          connectionNonce: this.providerConnectionNonce,
          connectionEpoch: 1,
          providerSessionIdSha256: null,
        },
      },
    });
    if (!isRecord(initialized.result)
      || initialized.result.protocolVersion !== MCP_PROTOCOL_VERSION
      || !isRecord(initialized.result.capabilities)
      || !isRecord(initialized.result.serverInfo)) {
      throw new GatewayProtocolError("tool gateway returned an invalid initialize result");
    }
    const resultMeta = initialized.result._meta;
    const providerConnection = isRecord(resultMeta)
      ? resultMeta[PROVIDER_CONNECTION_META_KEY]
      : undefined;
    if (!isRecord(providerConnection) || !exactKeys(providerConnection, [
      "schemaVersion", "connectionId", "connectionEpoch", "providerSessionIdSha256",
    ]) || providerConnection.schemaVersion !== 2
      || typeof providerConnection.connectionId !== "string"
      || !PROVIDER_CONNECTION_ID.test(providerConnection.connectionId)
      || providerConnection.connectionEpoch !== 1
      || providerConnection.providerSessionIdSha256 !== null) {
      throw new GatewayProtocolError("tool gateway did not attest the provider connection");
    }
    if (this.providerConnectionId !== null
      && this.providerConnectionId !== providerConnection.connectionId) {
      throw new GatewayProtocolError("tool gateway changed provider connection identity during MCP reconnect");
    }
    this.providerConnectionId = providerConnection.connectionId;
    const sessionId = boundedSessionId(initialized.sessionId);
    await this.initializedNotification(sessionId);
    this.assertRunning();
    this.sessionId = sessionId;
  }

  private async initializedNotification(sessionId: string): Promise<void> {
    const body = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
    const response = await this.request(body, sessionId);
    if (response.status !== 202 || response.body.length !== 0) {
      throw new GatewayProtocolError("tool gateway rejected the initialized notification", response.status);
    }
  }

  private async executeBatchSerial(
    calls: readonly BrowserCapabilityGatewayCall[],
    authority: ActiveCatalogAuthority,
  ): Promise<readonly BrowserCapabilityGatewayResult[]> {
    await this.initialize();
    const seen = new Set<string>();
    const prepared: Array<Readonly<{
      call: BrowserCapabilityGatewayCall;
      nativeCallId: string;
      targetName: string;
      targetArguments: Record<string, unknown>;
      provenance: Record<string, unknown>;
      authority: ActiveCatalogAuthority;
      fingerprint: string;
    }>> = [];
    for (const call of calls) {
      const value = await this.prepareCall(call, authority);
      if (seen.has(value.nativeCallId)) {
        throw new Error(`capability gateway batch repeated native call id ${value.nativeCallId}`);
      }
      seen.add(value.nativeCallId);
      prepared.push(value);
    }

    const replayCount = prepared.filter((call) => this.completedCalls.has(call.nativeCallId)).length;
    if (replayCount > 0 && replayCount !== prepared.length) {
      throw new Error("capability gateway batch mixed sealed replay with new provider calls");
    }

    const results: BrowserCapabilityGatewayResult[] = [];
    // Preserve provider order. Progressive flows can change authority after each
    // call, so parallel dispatch would make a batch's side effects nondeterministic.
    for (const call of prepared) results.push(await this.executePreparedCall(call));
    if (replayCount === 0) {
      let minimum = {
        capability_epoch: authority.capability_epoch,
        state_revision: this.activeStateRevision,
      };
      let finalCatalog: VerifiedActiveCatalog | null = null;
      for (const result of results) {
        finalCatalog = await verifiedResultEnvelope(
          result.output,
          this.activeRuntimeDigest,
          minimum,
          result.isError,
        );
        minimum = {
          capability_epoch: finalCatalog.capability_epoch,
          state_revision: finalCatalog.state_revision,
        };
      }
      if (!finalCatalog) throw new GatewayProtocolError("tool gateway returned an empty provider batch");
      this.activeCatalogAuthority = Object.freeze({
        catalog_digest: finalCatalog.catalog_digest,
        capability_epoch: finalCatalog.capability_epoch,
      });
      this.activeStateRevision = finalCatalog.state_revision;
      this.catalogBlocked = finalCatalog.availability === "blocked";
    }
    return Object.freeze(results);
  }

  private async prepareCall(call: BrowserCapabilityGatewayCall, authority: ActiveCatalogAuthority) {
    if (!isRecord(call)) throw new Error("capability gateway call must be an object");
    if (call.functionName !== CAPABILITY_GATEWAY_FUNCTION_NAME) {
      throw new Error(`provider attempted undeclared native function ${JSON.stringify(call.functionName)}`);
    }
    const nativeCallId = boundedOpaqueId(call.nativeCallId, "native call id", MAX_NATIVE_CALL_ID_BYTES);
    const nativeResponseId = boundedOpaqueId(call.nativeResponseId, "native response id", MAX_NATIVE_ID_BYTES);
    const terminalWireType = boundedOpaqueId(call.terminalWireType, "terminal wire type", 128);
    const nativeItemId = call.nativeItemId === undefined
      ? undefined
      : boundedOpaqueId(call.nativeItemId, "native item id", MAX_NATIVE_ID_BYTES);
    const terminalEventId = call.terminalEventId === undefined
      ? undefined
      : boundedOpaqueId(call.terminalEventId, "terminal event id", MAX_NATIVE_ID_BYTES);
    if (!isRecord(call.arguments) || !exactKeys(call.arguments, ["tool_name", "arguments"])) {
      throw new Error("capability_gateway arguments must contain exactly tool_name and arguments");
    }
    const targetName = call.arguments.tool_name;
    if (typeof targetName !== "string" || !MCP_TOOL_NAME.test(targetName)) {
      throw new Error("capability_gateway target tool name is invalid");
    }
    if (!isRecord(call.arguments.arguments)) {
      throw new Error("capability_gateway target arguments must be an object");
    }
    assertStrictJson(call.arguments.arguments, "capability_gateway.arguments");
    const targetArguments = JSON.parse(canonicalJson(call.arguments.arguments)) as Record<string, unknown>;
    if (!this.providerConnectionId) {
      throw new GatewayProtocolError("tool gateway provider connection is not initialized");
    }
    const provenance = Object.freeze({
      schemaVersion: 2,
      provider: this.provider,
      providerConnectionId: this.providerConnectionId,
      providerConnectionEpoch: 1,
      providerSessionIdSha256: null,
      nativeCallId,
      nativeResponseId,
      ...(nativeItemId ? { nativeItemId } : {}),
      ...(terminalEventId ? { terminalEventId } : {}),
      terminalWireType,
    });
    const fingerprint = await sha256(canonicalJson({
      functionName: call.functionName,
      targetName,
      targetArguments,
      provenance,
    }));
    const prior = this.callFingerprints.get(nativeCallId);
    if (prior !== undefined && prior !== fingerprint) {
      throw new Error(`native call id ${nativeCallId} was reused with different contents`);
    }
    if (prior === undefined) {
      if (this.callFingerprints.size >= MAX_TRACKED_CALL_IDENTITIES) {
        throw new Error(`capability gateway exceeded ${MAX_TRACKED_CALL_IDENTITIES} tracked native call identities`);
      }
      this.callFingerprints.set(nativeCallId, fingerprint);
    }
    return { call, nativeCallId, targetName, targetArguments, provenance, authority, fingerprint };
  }

  private executePreparedCall(call: Readonly<{
    nativeCallId: string;
    targetName: string;
    targetArguments: Record<string, unknown>;
    provenance: Record<string, unknown>;
    authority: ActiveCatalogAuthority;
  }>): Promise<BrowserCapabilityGatewayResult> {
    const completed = this.completedCalls.get(call.nativeCallId);
    if (completed) return Promise.resolve(completed);
    const existing = this.inFlightCalls.get(call.nativeCallId);
    if (existing) return existing;
    const pending = this.callTool(call).then((result) => {
      // Flow-control calls are intentionally sequential but some are not
      // backed by action receipts. Cache their exact provider result so a wire
      // replay cannot repeat a state transition or observe a later catalog.
      if (!this.stopped) this.completedCalls.set(call.nativeCallId, result);
      return result;
    }).finally(() => {
      if (this.inFlightCalls.get(call.nativeCallId) === pending) this.inFlightCalls.delete(call.nativeCallId);
    });
    this.inFlightCalls.set(call.nativeCallId, pending);
    return pending;
  }

  private async callTool(call: Readonly<{
    nativeCallId: string;
    targetName: string;
    targetArguments: Record<string, unknown>;
    provenance: Record<string, unknown>;
    authority: ActiveCatalogAuthority;
  }>): Promise<BrowserCapabilityGatewayResult> {
    const invoke = async () => {
      const requestId = this.boundedRequestId(this.randomId());
      const response = await this.rpc(requestId, "tools/call", {
        name: call.targetName,
        arguments: call.targetArguments,
        _meta: {
          [MCP_PROVIDER_TOOL_CALL_ID_META_KEY]: call.nativeCallId,
          [PROVIDER_PROVENANCE_META_KEY]: call.provenance,
          [ACTIVE_CATALOG_META_KEY]: call.authority,
        },
      }, this.sessionId ?? undefined);
      return this.parseToolResult(call.nativeCallId, response.result);
    };
    try {
      return await invoke();
    } catch (error) {
      if (!(error instanceof GatewayProtocolError)
        || (error.status !== 404 && error.rpcCode !== -32002)) throw error;
      // MCP sessions are transport continuity only. Reuse the exact provider
      // connection attestation and call ID so the durable receipt remains
      // identical without aliasing a later physical provider connection.
      await this.initialize(true);
      return invoke();
    }
  }

  private async parseToolResult(nativeCallId: string, value: unknown): Promise<BrowserCapabilityGatewayResult> {
    if (!isRecord(value) || !exactKeys(value, ["content", "isError"])
      || typeof value.isError !== "boolean" || !Array.isArray(value.content) || value.content.length !== 1) {
      throw new GatewayProtocolError("tool gateway returned an invalid tools/call result");
    }
    const item = value.content[0];
    if (!isRecord(item) || !exactKeys(item, ["type", "text"])
      || item.type !== "text" || typeof item.text !== "string") {
      throw new GatewayProtocolError("tool gateway tools/call result must contain exactly one text value");
    }
    let output: unknown;
    try {
      output = JSON.parse(item.text);
      assertStrictJson(output, "tool gateway result");
    } catch {
      throw new GatewayProtocolError("tool gateway tools/call text was not strict JSON");
    }
    await verifiedResultEnvelope(
      output,
      this.activeRuntimeDigest,
      {
        capability_epoch: this.activeCatalogAuthority.capability_epoch,
        state_revision: this.activeStateRevision,
      },
      value.isError,
    );
    return Object.freeze({ nativeCallId, output: deepFreezeJson(output), isError: value.isError });
  }

  private async rpc(
    id: JsonRpcId,
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<Readonly<{ result: unknown; sessionId?: string }>> {
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    const response = await this.request(body, sessionId);
    let value: unknown;
    try { value = JSON.parse(response.body); } catch {
      throw new GatewayProtocolError("tool gateway returned malformed JSON", response.status);
    }
    if (!isRecord(value) || value.jsonrpc !== "2.0" || value.id !== id
      || !Object.keys(value).every((key) => ["jsonrpc", "id", "result", "error"].includes(key))) {
      throw new GatewayProtocolError("tool gateway response identity mismatch", response.status);
    }
    if (!response.ok) {
      const rpcCode = isRecord(value.error) && Number.isSafeInteger(value.error.code)
        ? value.error.code as number
        : undefined;
      throw new GatewayProtocolError(`tool gateway HTTP ${response.status}`, response.status, rpcCode);
    }
    if (isRecord(value.error)) {
      const code = Number.isSafeInteger(value.error.code) ? value.error.code as number : undefined;
      const message = typeof value.error.message === "string" ? value.error.message.slice(0, 2_000) : "tool gateway error";
      throw new GatewayProtocolError(message, response.status, code);
    }
    if (!own(value, "result") || own(value, "error")) {
      throw new GatewayProtocolError("tool gateway response omitted result", response.status);
    }
    const issuedSessionId = response.headers.get("mcp-session-id");
    return { result: value.result, ...(issuedSessionId ? { sessionId: issuedSessionId } : {}) };
  }

  private async request(body: string, sessionId?: string): Promise<Readonly<{
    ok: boolean;
    status: number;
    headers: Headers;
    body: string;
  }>> {
    this.assertRunning();
    if (utf8Bytes(body) > MAX_MCP_REQUEST_BYTES) {
      throw new GatewayProtocolError("tool gateway request exceeded 256 KiB");
    }
    const controller = new AbortController();
    this.abortControllers.add(controller);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new GatewayProtocolError("tool gateway request timed out"));
        }, this.timeoutMs);
      });
      const operation = (async () => {
        const response = await this.fetchImpl(this.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.token}`,
            ...(sessionId ? { "MCP-Session-Id": boundedSessionId(sessionId) } : {}),
          },
          body,
          redirect: "error",
          signal: controller.signal,
        });
        if (response.redirected) throw new GatewayProtocolError("tool gateway redirects are forbidden");
        const responseBody = await readBoundedResponseText(
          response,
          BROWSER_REALTIME_LIMITS.providerEventBytes,
          "tool gateway response",
        );
        return {
          ok: response.ok,
          status: response.status,
          headers: response.headers,
          body: responseBody,
        };
      })();
      return await Promise.race([operation, deadline]);
    } catch (error) {
      if (controller.signal.aborted && this.stopped) {
        throw new GatewayProtocolError("tool gateway client was stopped");
      }
      if (error instanceof GatewayProtocolError) throw error;
      throw new GatewayProtocolError(safeDiagnostic(error));
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      this.abortControllers.delete(controller);
    }
  }

  private boundedRequestId(value: unknown): string {
    return boundedOpaqueId(value, "JSON-RPC id", 256);
  }

  private assertRunning(): void {
    if (this.stopped) throw new Error("tool gateway client is stopped");
  }
}
