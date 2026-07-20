// Immutable remote-MCP discovery and server-side execution for secured voice flows.

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ValidateFunction } from "ajv/dist/2020";
import { qOne } from "./db";
import {
  ExternalMcpManifestSchema,
  externalMcpCatalogHash,
  externalMcpEndpointHash,
  externalMcpToolSchemaHash,
  type PinnedExternalMcpManifest,
  type PinnedExternalMcpTool,
} from "./call-runtime-snapshot";
import { hashFlowValue } from "./flow-runtime";
import {
  McpClientError,
  StreamableHttpMcpClient,
  namespaceMcpTools,
  type McpInitializeResult,
  type McpRequestOptions,
  type McpToolCallOptions,
  type McpToolCallResult,
  type McpToolDefinition,
  type StreamableHttpMcpClientOptions,
} from "./mcp-client";
import {
  decryptCredentialSecret,
  type CredentialSecretContext,
} from "./vault";
import {
  compileVoiceToolSchema,
  normalizeVoiceToolSchema,
} from "./voice-tools/schema";

export type McpRegistryServer = {
  id: string;
  org_id: string;
  label: string;
  server_url: string;
  allowed_tools: string[] | null;
  auth_header_encrypted: string | null;
  auth_encryption_slot_id: string | null;
  approved_manifest?: unknown | null;
  approved_catalog_hash?: string | null;
  /** One-way emergency cutoff. Omitted only by trusted registration-time construction. */
  revoked_at?: string | Date | null;
  revoked_by?: string | null;
  revocation_reason?: string | null;
};

export const MAX_ATTACHED_REMOTE_MCP_SERVERS = 8;
export const MAX_REMOTE_MCP_TOOLS_PER_SERVER = 256;
export const MAX_REMOTE_MCP_TOOLS_PER_CALL = 512;
export const MAX_REMOTE_MCP_MANIFEST_BYTES_PER_CALL = 1024 * 1024;

const REMOTE_MCP_REQUEST_TIMEOUT_MS = 8_000;
const REMOTE_MCP_TOOL_TIMEOUT_MS = 25_000;
const REMOTE_MCP_ACTION_TIMEOUT_MS = 45_000;
const REMOTE_MCP_MAX_RESPONSE_BYTES = 1024 * 1024;
const REMOTE_MCP_MAX_ARGUMENT_BYTES = 240 * 1024;
const MAX_VALIDATOR_CACHE_ENTRIES = 1024;
const validatorCache = new Map<string, ValidateFunction>();

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export type RemoteMcpClient = {
  initialize(options?: McpRequestOptions): Promise<McpInitializeResult>;
  listTools(options?: McpRequestOptions): Promise<McpToolDefinition[]>;
  callTool(
    name: string,
    args?: Record<string, unknown>,
    options?: McpToolCallOptions
  ): Promise<McpToolCallResult>;
  close(options?: McpRequestOptions): Promise<void>;
};

export type RemoteMcpAddressPinningEvidence = Readonly<{
  version: 1;
  kind: "address_pinning_connector";
  endpoint: string;
  hostname: string;
  resolvedAddresses: readonly string[];
  tlsServerName: string;
  tlsHostnameVerification: true;
  redirects: "blocked";
}>;

/**
 * Trusted deployment adapter that prepares a transport bound to the same validated addresses
 * described by its evidence. The runtime validates the evidence shape and public IP set; the
 * connector remains responsible for actually pinning sockets while preserving TLS verification.
 */
export type RemoteMcpAddressPinningConnector = Readonly<{
  prepare(endpoint: URL, operation: Readonly<{
    signal: AbortSignal;
    timeoutMs: number;
  }>): Promise<Readonly<{
    evidence: RemoteMcpAddressPinningEvidence;
    clientFactory: (options: StreamableHttpMcpClientOptions) => RemoteMcpClient;
  }>>;
}>;

export type RemoteMcpRuntimeDependencies = {
  clientFactory?: (options: StreamableHttpMcpClientOptions) => RemoteMcpClient;
  addressPinningConnector?: RemoteMcpAddressPinningConnector;
  decrypt?: (encrypted: string, context: CredentialSecretContext) => string;
  endpointPolicy?: (endpoint: URL) => boolean | Promise<boolean>;
  loadServer?: (serverId: string, orgId: string) => Promise<McpRegistryServer | null>;
  now?: () => Date;
};

const MAX_AUTHORIZATION_HEADER_BYTES = 8_192;
const AUTH_SCHEME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const BEARER_CREDENTIAL_PATTERN = /^[A-Za-z0-9._~+/=-]+$/;

type ValidatedAuthorizationHeader = Readonly<{
  value: string;
  scheme: string;
  credential: string;
  basic?: Readonly<{ decoded: string; username: string; password: string }>;
}>;

/**
 * Authorization credentials are treated as tainted remote input as well as secrets. Requiring a
 * bounded, canonical shape lets result redaction cover every sensitive component without adding
 * one-character/global replacements or an attacker-controlled number of replacement candidates.
 */
function validatedAuthorizationHeader(value: string): ValidatedAuthorizationHeader | null {
  if (
    Buffer.byteLength(value, "utf8") > MAX_AUTHORIZATION_HEADER_BYTES ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) return null;
  const separator = value.indexOf(" ");
  if (separator < 1 || separator === value.length - 1) return null;
  const rawScheme = value.slice(0, separator);
  const credential = value.slice(separator + 1);
  if (
    !AUTH_SCHEME_PATTERN.test(rawScheme) ||
    credential.trim() !== credential ||
    Buffer.byteLength(credential, "utf8") < 8
  ) return null;
  const scheme = rawScheme.toLowerCase();
  // Non-Basic schemes are accepted only as one token68-style credential. Compound parameter
  // schemes need a purpose-built parser before their independently reflectable components can
  // be redacted safely.
  if (scheme !== "basic" && !BEARER_CREDENTIAL_PATTERN.test(credential)) return null;
  if (scheme !== "basic") return { value, scheme, credential };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(credential)) return null;
  try {
    const decodedBytes = Buffer.from(credential, "base64");
    if (
      decodedBytes.toString("base64").replace(/=+$/, "") !== credential.replace(/=+$/, "") ||
      decodedBytes.byteLength > 4_096
    ) return null;
    const decoded = decodedBytes.toString("utf8");
    if (!Buffer.from(decoded, "utf8").equals(decodedBytes) || /[\u0000-\u001f\u007f]/.test(decoded)) {
      return null;
    }
    const colon = decoded.indexOf(":");
    if (colon < 0) return null;
    const username = decoded.slice(0, colon);
    const password = decoded.slice(colon + 1);
    if (Buffer.byteLength(username, "utf8") < 1 || Buffer.byteLength(password, "utf8") < 8) {
      return null;
    }
    return { value, scheme, credential, basic: { decoded, username, password } };
  } catch {
    return null;
  }
}

function authorizationForServer(
  server: McpRegistryServer,
  deps: RemoteMcpRuntimeDependencies,
  expectedOrgId?: string
): string | undefined {
  if (!server.org_id || (expectedOrgId !== undefined && server.org_id !== expectedOrgId)) {
    throw new RemoteMcpPreflightError("remote_mcp_configuration_invalid");
  }
  if (server.auth_header_encrypted === null) {
    if (server.auth_encryption_slot_id !== null) {
      throw new RemoteMcpPreflightError("remote_mcp_configuration_invalid");
    }
    return undefined;
  }
  if (
    !server.auth_encryption_slot_id
  ) throw new RemoteMcpPreflightError("remote_mcp_configuration_invalid");
  const context: CredentialSecretContext = {
    orgId: server.org_id,
    sinkKind: "mcp_server",
    sinkId: server.id,
    slotId: server.auth_encryption_slot_id,
  };
  try {
    const authorization = (deps.decrypt ?? decryptCredentialSecret)(server.auth_header_encrypted, context);
    if (!validatedAuthorizationHeader(authorization)) {
      throw new RemoteMcpPreflightError("remote_mcp_configuration_invalid");
    }
    return authorization;
  } catch {
    throw new RemoteMcpPreflightError("remote_mcp_configuration_invalid");
  }
}

export class RemoteMcpPreflightError extends Error {
  readonly code:
    | "remote_mcp_configuration_invalid"
    | "remote_mcp_deployment_blocked"
    | "remote_mcp_unavailable"
    | "remote_mcp_revoked"
    | "remote_mcp_provenance_drift"
    | "remote_mcp_schema_drift";

  constructor(code: RemoteMcpPreflightError["code"]) {
    const messages: Record<RemoteMcpPreflightError["code"], string> = {
      remote_mcp_configuration_invalid: "The pinned remote MCP configuration is invalid.",
      remote_mcp_deployment_blocked: "Remote MCP is disabled until production network egress controls are configured.",
      remote_mcp_unavailable: "The pinned remote MCP server is unavailable.",
      remote_mcp_revoked: "The pinned remote MCP authority was revoked by an operator.",
      remote_mcp_provenance_drift: "The remote MCP registry entry changed after this call started.",
      remote_mcp_schema_drift: "The remote MCP schema changed after this call started.",
    };
    super(messages[code]);
    this.name = "RemoteMcpPreflightError";
    this.code = code;
  }
}

function assertRemoteMcpAuthorityActive(server: McpRegistryServer): void {
  if (server.revoked_at !== undefined && server.revoked_at !== null) {
    throw new RemoteMcpPreflightError("remote_mcp_revoked");
  }
}

/** Thrown only after a remote tools/call request began; the receipt must remain indeterminate. */
export class RemoteMcpActionIndeterminateError extends Error {
  readonly code = "remote_mcp_action_indeterminate";

  constructor() {
    super("The remote MCP action outcome is indeterminate.");
    this.name = "RemoteMcpActionIndeterminateError";
  }
}

export type RemoteMcpToolInvocationOutcome =
  | Readonly<{
      outcome: "succeeded";
      acknowledged: true;
      value: unknown;
    }>
  | Readonly<{
      outcome: "rejected";
      acknowledged: false;
      error: string;
      code: string;
    }>;

export type RemoteMcpInvocationContext = Readonly<{
  invocationId: string;
  idempotencyKey: string;
}>;

function canonicalServerUrl(value: string): string {
  try {
    const url = new URL(value);
    // Query strings are frequently used for bearer/API-key credentials and the URL is pinned
    // in plaintext. Require path-based endpoints and carry all authorization in the vault.
    if (url.search || url.hash || url.username || url.password) {
      throw new RemoteMcpPreflightError("remote_mcp_configuration_invalid");
    }
    return url.toString();
  } catch {
    throw new RemoteMcpPreflightError("remote_mcp_configuration_invalid");
  }
}

/** Browser ingest and server-side consume must bind the credential to this exact endpoint. */
export function mcpAuthorizationCredentialPurpose(serverUrl: string): string {
  const canonical = canonicalServerUrl(serverUrl);
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `mcp_authorization:${digest}`;
}

function canonicalAllowedTools(value: string[] | null): string[] | null {
  if (value === null) return null;
  if (value.some((name) => typeof name !== "string" || !name)) {
    throw new RemoteMcpPreflightError("remote_mcp_configuration_invalid");
  }
  const unique = new Set(value);
  if (unique.size !== value.length) {
    throw new RemoteMcpPreflightError("remote_mcp_configuration_invalid");
  }
  return [...unique].sort(compareCodeUnits);
}

function equalStringLists(left: string[] | null, right: string[] | null): boolean {
  if (left === null || right === null) return left === right;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Stable across label edits; the exact UUID is retained in the namespace hash. */
export function remoteMcpNamespace(serverId: string): string {
  if (!serverId) throw new RemoteMcpPreflightError("remote_mcp_configuration_invalid");
  return `server_${serverId}`;
}

/** Fingerprints ciphertext revision, never the decrypted Authorization value. */
export function encryptedMcpAuthFingerprint(encrypted: string | null): string | null {
  return encrypted === null
    ? null
    : createHash("sha256").update(encrypted, "utf8").digest("hex");
}

function ipv4Number(address: string): number | null {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function ipv4InCidr(value: number, base: string, bits: number): boolean {
  const baseValue = ipv4Number(base);
  if (baseValue === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

function isPublicIpv4(address: string): boolean {
  const value = ipv4Number(address);
  if (value === null) return false;
  const blocked: [string, number][] = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
    ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
    ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
    ["224.0.0.0", 4], ["240.0.0.0", 4],
  ];
  return !blocked.some(([base, bits]) => ipv4InCidr(value, base, bits));
}

function ipv6BigInt(address: string): bigint | null {
  let input = address.toLowerCase();
  if (input.includes("%")) return null;
  if (input.includes(".")) {
    const lastColon = input.lastIndexOf(":");
    if (lastColon < 0) return null;
    const v4 = ipv4Number(input.slice(lastColon + 1));
    if (v4 === null) return null;
    input = `${input.slice(0, lastColon)}:${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = input.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (left.some((part) => !/^[0-9a-f]{1,4}$/.test(part)) ||
      right.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const parts = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (parts.length !== 8) return null;
  return parts.reduce((value, part) => (value << BigInt(16)) | BigInt(`0x${part}`), BigInt(0));
}

function ipv6InCidr(value: bigint, base: bigint, bits: number): boolean {
  const shift = BigInt(128 - bits);
  return (value >> shift) === (base >> shift);
}

function isPublicIpv6(address: string): boolean {
  const value = ipv6BigInt(address);
  if (value === null) return false;
  const mappedBase = BigInt("0xffff") << BigInt(32);
  if (ipv6InCidr(value, mappedBase, 96)) {
    const low = Number(value & BigInt("0xffffffff"));
    return isPublicIpv4([
      (low >>> 24) & 255,
      (low >>> 16) & 255,
      (low >>> 8) & 255,
      low & 255,
    ].join("."));
  }
  // Require globally routable 2000::/3, then exclude documentation and special assignments.
  if (!ipv6InCidr(value, BigInt("0x20000000000000000000000000000000"), 3)) return false;
  const blocked: [bigint, number][] = [
    [BigInt("0x20010000000000000000000000000000"), 23],
    [BigInt("0x20010db8000000000000000000000000"), 32],
    [BigInt("0x20020000000000000000000000000000"), 16],
    [BigInt("0x3fff0000000000000000000000000000"), 20],
  ];
  return !blocked.some(([base, bits]) => ipv6InCidr(value, base, bits));
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

const PRODUCTION_EGRESS_GUARD_ASSERTION = "private-ranges-blocked";

function configuredProductionEgressHosts(): ReadonlySet<string> {
  return new Set((process.env.MCP_EGRESS_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => stripIpv6Brackets(host.trim().toLowerCase()))
    .filter(Boolean));
}

/**
 * This is deliberately an operator/deployment assertion, not proof that the platform really
 * enforces socket-layer egress. It prevents accidental production enablement; an address-pinning
 * connector or independently audited firewall remains the stronger control.
 */
function productionEgressGateAllows(endpoint: URL): boolean {
  if (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test") return true;
  if (process.env.NODE_ENV !== "production") return false;
  const hostname = stripIpv6Brackets(endpoint.hostname.toLowerCase());
  return !!hostname &&
    process.env.MCP_EGRESS_NETWORK_GUARD === PRODUCTION_EGRESS_GUARD_ASSERTION &&
    configuredProductionEgressHosts().has(hostname);
}

function assertRemoteMcpDeploymentGate(endpoint: URL): void {
  if (!productionEgressGateAllows(endpoint)) {
    throw new RemoteMcpPreflightError("remote_mcp_deployment_blocked");
  }
}

/**
 * Application-layer SSRF defense. Production should additionally enforce a network egress
 * policy because DNS can still change between this lookup and the platform fetch socket.
 */
export async function defaultRemoteMcpEndpointPolicy(endpoint: URL): Promise<boolean> {
  const hostname = stripIpv6Brackets(endpoint.hostname.toLowerCase());
  if (!hostname) return false;
  if (!productionEgressGateAllows(endpoint)) return false;
  if (process.env.NODE_ENV !== "production" &&
      (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1")) {
    return true;
  }
  const literal = isIP(hostname);
  if (literal === 4) return isPublicIpv4(hostname);
  if (literal === 6) return isPublicIpv6(hostname);
  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    return addresses.length > 0 && addresses.every(({ address, family }) =>
      family === 4 ? isPublicIpv4(address) : family === 6 ? isPublicIpv6(address) : false
    );
  } catch {
    return false;
  }
}

function endpointPolicyFor(
  expectedUrl: string,
  override?: RemoteMcpRuntimeDependencies["endpointPolicy"]
): (endpoint: URL) => Promise<boolean> {
  const expected = new URL(expectedUrl).toString();
  return async (endpoint) => {
    if (endpoint.toString() !== expected) return false;
    if (!(await defaultRemoteMcpEndpointPolicy(endpoint))) return false;
    return override ? override(endpoint) : true;
  };
}

function factoryFor(deps: RemoteMcpRuntimeDependencies) {
  return deps.clientFactory ?? ((options: StreamableHttpMcpClientOptions) =>
    new StreamableHttpMcpClient(options));
}

function validAddressPinningEvidence(
  endpoint: URL,
  evidence: RemoteMcpAddressPinningEvidence
): boolean {
  const hostname = stripIpv6Brackets(endpoint.hostname.toLowerCase());
  if (!evidence || evidence.version !== 1 || evidence.kind !== "address_pinning_connector" ||
      evidence.endpoint !== endpoint.toString() || evidence.hostname !== hostname ||
      evidence.tlsServerName !== hostname || evidence.tlsHostnameVerification !== true ||
      evidence.redirects !== "blocked" || !Array.isArray(evidence.resolvedAddresses) ||
      evidence.resolvedAddresses.length === 0 || evidence.resolvedAddresses.length > 32) {
    return false;
  }
  const unique = new Set(evidence.resolvedAddresses);
  return unique.size === evidence.resolvedAddresses.length &&
    evidence.resolvedAddresses.every((address) => {
      const family = isIP(address);
      return family === 4 ? isPublicIpv4(address) : family === 6 ? isPublicIpv6(address) : false;
    });
}

async function prepareRemoteMcpClientFactory(
  endpoint: URL,
  deps: RemoteMcpRuntimeDependencies,
  operation: McpRequestOptions = {}
): Promise<(options: StreamableHttpMcpClientOptions) => RemoteMcpClient> {
  // Missing/wrong production deployment evidence must fail before connector preparation,
  // credential decryption, DNS lookup, or any remote request.
  assertRemoteMcpDeploymentGate(endpoint);
  if (!deps.addressPinningConnector) return factoryFor(deps);
  const timeoutMs = Math.min(
    operation.timeoutMs ?? REMOTE_MCP_REQUEST_TIMEOUT_MS,
    REMOTE_MCP_REQUEST_TIMEOUT_MS
  );
  const controller = new AbortController();
  const abort = () => controller.abort(operation.signal?.reason ?? new Error("remote_mcp_connector_aborted"));
  if (operation.signal?.aborted) abort();
  else operation.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("remote_mcp_connector_timeout")),
    timeoutMs
  );
  let prepared: Awaited<ReturnType<RemoteMcpAddressPinningConnector["prepare"]>>;
  try {
    prepared = await Promise.race([
      deps.addressPinningConnector.prepare(new URL(endpoint), {
        signal: controller.signal,
        timeoutMs,
      }),
      new Promise<never>((_resolve, reject) => {
        if (controller.signal.aborted) reject(controller.signal.reason);
        else controller.signal.addEventListener(
          "abort",
          () => reject(controller.signal.reason),
          { once: true }
        );
      }),
    ]);
  } catch {
    throw new RemoteMcpPreflightError("remote_mcp_deployment_blocked");
  } finally {
    clearTimeout(timer);
    operation.signal?.removeEventListener("abort", abort);
  }
  if (!validAddressPinningEvidence(endpoint, prepared.evidence) ||
      typeof prepared.clientFactory !== "function") {
    throw new RemoteMcpPreflightError("remote_mcp_deployment_blocked");
  }
  return prepared.clientFactory;
}

function pinnedTools(
  namespace: string,
  definitions: readonly McpToolDefinition[]
): PinnedExternalMcpTool[] {
  return namespaceMcpTools(namespace, definitions)
    .map((tool) => {
      const definition = {
        // Flow/provider common denominator is lowercase. The suffix still hashes the exact,
        // case-sensitive remote name, so ReserveSlot and reserveslot cannot collide.
        name: tool.name.toLowerCase(),
        remoteName: tool.remoteName,
        namespace: tool.namespace,
        ...(tool.title !== undefined ? { title: tool.title } : {}),
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
      };
      return { ...definition, schemaHash: externalMcpToolSchemaHash(definition) };
    })
    .sort((left, right) => compareCodeUnits(left.name, right.name));
}

function cacheValidator(key: string, schema: Record<string, unknown>): ValidateFunction {
  const existing = validatorCache.get(key);
  if (existing) return existing;
  let validator: ValidateFunction;
  try {
    const normalized = normalizeVoiceToolSchema(schema, {
      label: "remote MCP tool schema",
      requireObjectRoot: true,
    });
    validator = compileVoiceToolSchema(normalized);
  } catch {
    throw new RemoteMcpPreflightError("remote_mcp_configuration_invalid");
  }
  if (validatorCache.size >= MAX_VALIDATOR_CACHE_ENTRIES) {
    const oldest = validatorCache.keys().next().value as string | undefined;
    if (oldest !== undefined) validatorCache.delete(oldest);
  }
  validatorCache.set(key, validator);
  return validator;
}

function isBoundedGatewayJson(value: unknown): boolean {
  let nodes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > 10_000 || depth > 32) return false;
    if (item === null || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item === "string") return item.length <= 64 * 1024;
    if (Array.isArray(item)) return item.length <= 256 && item.every((entry) => visit(entry, depth + 1));
    if (!item || typeof item !== "object") return false;
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const entries = Object.entries(item as Record<string, unknown>);
    return entries.length <= 256 && entries.every(([key, entry]) =>
      key.length <= 1_024 && visit(entry, depth + 1)
    );
  };
  if (!visit(value, 0)) return false;
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= REMOTE_MCP_MAX_ARGUMENT_BYTES;
  } catch {
    return false;
  }
}

function validatePinnedSchema(
  tool: PinnedExternalMcpTool,
  kind: "input" | "output",
  value: unknown
): boolean {
  const schema = kind === "input" ? tool.inputSchema : tool.outputSchema;
  if (!schema) return true;
  return cacheValidator(`${tool.schemaHash}:${kind}`, schema)(value) === true;
}

function validateDiscoveredSchemas(definitions: readonly McpToolDefinition[]): void {
  for (const definition of definitions) {
    const namespace = "schema_validation";
    const [tool] = pinnedTools(namespace, [definition]);
    cacheValidator(`${tool.schemaHash}:input`, tool.inputSchema);
    if (tool.outputSchema) cacheValidator(`${tool.schemaHash}:output`, tool.outputSchema);
  }
}

function containsExactSecret(value: unknown, secrets: readonly string[]): boolean {
  if (typeof value === "string") return secrets.some((secret) => value.includes(secret));
  if (Array.isArray(value)) return value.some((item) => containsExactSecret(item, secrets));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>)
    .some(([key, item]) => containsExactSecret(key, secrets) || containsExactSecret(item, secrets));
}

function assertAllowlistResolved(
  allowedTools: string[] | null,
  definitions: readonly McpToolDefinition[]
): void {
  if (allowedTools === null) return;
  const discovered = new Set(definitions.map((tool) => tool.name));
  if (allowedTools.some((tool) => !discovered.has(tool)) || discovered.size !== allowedTools.length) {
    throw new RemoteMcpPreflightError("remote_mcp_configuration_invalid");
  }
}

async function closeQuietly(client: RemoteMcpClient): Promise<void> {
  await client.close({ timeoutMs: 2_000 }).catch(() => undefined);
}

/** Discovers, sanitizes, namespacing, hashes, and freezes a server catalog at call start. */
export async function snapshotExternalMcpServer(
  server: McpRegistryServer,
  deps: RemoteMcpRuntimeDependencies = {}
): Promise<PinnedExternalMcpManifest> {
  // This must precede URL resolution, transport construction, and credential decryption.
  assertRemoteMcpAuthorityActive(server);
  const serverUrl = canonicalServerUrl(server.server_url);
  const allowedTools = canonicalAllowedTools(server.allowed_tools);
  const namespace = remoteMcpNamespace(server.id);
  const clientFactory = await prepareRemoteMcpClientFactory(new URL(serverUrl), deps, {
    timeoutMs: REMOTE_MCP_REQUEST_TIMEOUT_MS,
  });
  const authorization = authorizationForServer(server, deps);
  const client = clientFactory({
    endpoint: serverUrl,
    ...(authorization !== undefined ? { authorization } : {}),
    ...(allowedTools !== null ? { allowedTools } : {}),
    endpointPolicy: endpointPolicyFor(serverUrl, deps.endpointPolicy),
    requestTimeoutMs: REMOTE_MCP_REQUEST_TIMEOUT_MS,
    toolCallTimeoutMs: REMOTE_MCP_TOOL_TIMEOUT_MS,
    maxResponseBytes: REMOTE_MCP_MAX_RESPONSE_BYTES,
    maxPages: 20,
    maxTools: MAX_REMOTE_MCP_TOOLS_PER_SERVER,
  });
  try {
    const initialized = await client.initialize();
    const definitions = await client.listTools();
    assertAllowlistResolved(allowedTools, definitions);
    const exactSecrets = exactSecretRepresentations(authorization);
    if (containsExactSecret({ label: server.label, initialized, definitions }, exactSecrets)) {
      throw new RemoteMcpPreflightError("remote_mcp_configuration_invalid");
    }
    validateDiscoveredSchemas(definitions);
    const tools = pinnedTools(namespace, definitions);
    const catalogHash = externalMcpCatalogHash(tools);
    const manifest = {
      manifestVersion: 2 as const,
      id: server.id,
      label: server.label,
      namespace,
      serverUrl,
      allowedTools,
      source: {
        kind: "mcp_server_registry" as const,
        serverId: server.id,
        endpointSha256: externalMcpEndpointHash(serverUrl),
        authEncryptedSha256: encryptedMcpAuthFingerprint(server.auth_header_encrypted),
      },
      protocolVersion: initialized.protocolVersion,
      serverInfo: initialized.serverInfo,
      tools,
      catalogHash,
      discoveryHash: hashFlowValue({
        protocolVersion: initialized.protocolVersion,
        serverInfo: initialized.serverInfo,
        catalogHash,
      }),
      discoveredAt: (deps.now ?? (() => new Date()))().toISOString(),
    };
    return ExternalMcpManifestSchema.parse(manifest) as PinnedExternalMcpManifest;
  } catch (error) {
    if (error instanceof RemoteMcpPreflightError) throw error;
    if (error instanceof McpClientError) {
      throw new RemoteMcpPreflightError("remote_mcp_unavailable");
    }
    throw new RemoteMcpPreflightError("remote_mcp_configuration_invalid");
  } finally {
    await closeQuietly(client);
  }
}

async function defaultLoadServer(serverId: string, orgId: string): Promise<McpRegistryServer | null> {
  return qOne<McpRegistryServer>(
    `SELECT id, org_id, label, server_url, allowed_tools, auth_header_encrypted,
            auth_encryption_slot_id, approved_manifest, approved_catalog_hash,
            revoked_at, revoked_by, revocation_reason
     FROM mcp_servers WHERE id = $1 AND org_id = $2`,
    [serverId, orgId]
  );
}

function validateRegistryProvenance(
  manifest: PinnedExternalMcpManifest,
  server: McpRegistryServer
): { serverUrl: string; allowedTools: string[] | null } {
  // Fail before endpoint-policy/DNS work and before authorizationForServer decrypts anything.
  assertRemoteMcpAuthorityActive(server);
  const serverUrl = canonicalServerUrl(server.server_url);
  const allowedTools = canonicalAllowedTools(server.allowed_tools);
  if (
    server.id !== manifest.source.serverId ||
    server.label !== manifest.label ||
    serverUrl !== manifest.serverUrl ||
    externalMcpEndpointHash(serverUrl) !== manifest.source.endpointSha256 ||
    !equalStringLists(allowedTools, manifest.allowedTools) ||
    encryptedMcpAuthFingerprint(server.auth_header_encrypted) !== manifest.source.authEncryptedSha256
  ) {
    throw new RemoteMcpPreflightError("remote_mcp_provenance_drift");
  }
  return { serverUrl, allowedTools };
}

async function loadPinnedRegistryRevision(
  manifest: PinnedExternalMcpManifest,
  orgId: string,
  deps: RemoteMcpRuntimeDependencies
): Promise<McpRegistryServer> {
  const server = await (deps.loadServer ?? defaultLoadServer)(manifest.source.serverId, orgId);
  if (!server) throw new RemoteMcpPreflightError("remote_mcp_provenance_drift");
  // A custom registry loader is still trusted infrastructure, but its result must be
  // self-authenticating before endpoint-policy, connector/DNS, or decryption work begins.
  // The default SQL also carries this predicate; repeating it here prevents a dependency bug
  // from turning cross-tenant public metadata into transport preparation.
  if (server.org_id !== orgId) {
    throw new RemoteMcpPreflightError("remote_mcp_configuration_invalid");
  }
  if (server.approved_catalog_hash !== undefined &&
      server.approved_catalog_hash !== null &&
      server.approved_catalog_hash !== manifest.catalogHash) {
    throw new RemoteMcpPreflightError("remote_mcp_provenance_drift");
  }
  validateRegistryProvenance(manifest, server);
  return server;
}

/** Loads the catalog explicitly accepted at registration; live discovery can only verify it. */
export function approvedExternalMcpManifest(
  server: McpRegistryServer
): PinnedExternalMcpManifest {
  if (!server.approved_manifest || !server.approved_catalog_hash) {
    throw new RemoteMcpPreflightError("remote_mcp_configuration_invalid");
  }
  const parsed = ExternalMcpManifestSchema.safeParse(server.approved_manifest);
  if (!parsed.success || !("tools" in parsed.data) || !("source" in parsed.data)) {
    throw new RemoteMcpPreflightError("remote_mcp_configuration_invalid");
  }
  const manifest = parsed.data as PinnedExternalMcpManifest;
  validateRegistryProvenance(manifest, server);
  if (manifest.catalogHash !== server.approved_catalog_hash) {
    throw new RemoteMcpPreflightError("remote_mcp_provenance_drift");
  }
  return manifest;
}

type VerifiedRemoteMcp = {
  client: RemoteMcpClient;
  authorization?: string;
};

async function openVerifiedRemoteMcp(
  manifest: PinnedExternalMcpManifest,
  orgId: string,
  deps: RemoteMcpRuntimeDependencies,
  operation: McpRequestOptions = {}
): Promise<VerifiedRemoteMcp> {
  const server = await loadPinnedRegistryRevision(manifest, orgId, deps);
  const { serverUrl, allowedTools } = validateRegistryProvenance(manifest, server);
  const clientFactory = await prepareRemoteMcpClientFactory(new URL(serverUrl), deps, operation);
  const authorization = authorizationForServer(server, deps, orgId);
  const client = clientFactory({
    endpoint: serverUrl,
    ...(authorization !== undefined ? { authorization } : {}),
    ...(allowedTools !== null ? { allowedTools } : {}),
    endpointPolicy: endpointPolicyFor(serverUrl, deps.endpointPolicy),
    requestTimeoutMs: REMOTE_MCP_REQUEST_TIMEOUT_MS,
    toolCallTimeoutMs: REMOTE_MCP_TOOL_TIMEOUT_MS,
    maxResponseBytes: REMOTE_MCP_MAX_RESPONSE_BYTES,
    maxPages: 20,
    maxTools: MAX_REMOTE_MCP_TOOLS_PER_SERVER,
  });
  try {
    const initialized = await client.initialize({
      ...operation,
      timeoutMs: Math.min(operation.timeoutMs ?? REMOTE_MCP_REQUEST_TIMEOUT_MS, REMOTE_MCP_REQUEST_TIMEOUT_MS),
    });
    const definitions = await client.listTools({
      ...operation,
      timeoutMs: Math.min(operation.timeoutMs ?? REMOTE_MCP_REQUEST_TIMEOUT_MS, REMOTE_MCP_REQUEST_TIMEOUT_MS),
    });
    assertAllowlistResolved(allowedTools, definitions);
    const exactSecrets = exactSecretRepresentations(authorization);
    if (containsExactSecret({ initialized, definitions }, exactSecrets)) {
      throw new RemoteMcpPreflightError("remote_mcp_schema_drift");
    }
    validateDiscoveredSchemas(definitions);
    const tools = pinnedTools(manifest.namespace, definitions);
    const catalogHash = externalMcpCatalogHash(tools);
    const discoveryHash = hashFlowValue({
      protocolVersion: initialized.protocolVersion,
      serverInfo: initialized.serverInfo,
      catalogHash,
    });
    if (
      initialized.protocolVersion !== manifest.protocolVersion ||
      catalogHash !== manifest.catalogHash ||
      discoveryHash !== manifest.discoveryHash
    ) {
      throw new RemoteMcpPreflightError("remote_mcp_schema_drift");
    }
    return { client, ...(authorization !== undefined ? { authorization } : {}) };
  } catch (error) {
    await closeQuietly(client);
    if (error instanceof RemoteMcpPreflightError) throw error;
    throw new RemoteMcpPreflightError("remote_mcp_unavailable");
  }
}

/** Verifies endpoint, auth revision, protocol, server revision, and schemas without dispatch. */
export async function verifyPinnedExternalMcpManifest(
  manifest: PinnedExternalMcpManifest,
  orgId: string,
  deps: RemoteMcpRuntimeDependencies = {}
): Promise<void> {
  const verified = await openVerifiedRemoteMcp(manifest, orgId, deps);
  await closeQuietly(verified.client);
}

const SENSITIVE_RESULT_KEY = /(authorization|credential|api[_-]?key|private[_-]?key|client[_-]?secret|secret|password|access[_-]?token|refresh[_-]?token|session[_-]?(?:token|cookie)|cookie|jwt|bearer)/i;

function exactSecretRepresentations(authorization?: string): string[] {
  if (!authorization) return [];
  const parsed = validatedAuthorizationHeader(authorization);
  if (!parsed) return [];
  const candidates = new Set([
    parsed.value,
    encodeURIComponent(parsed.value),
    parsed.credential,
    encodeURIComponent(parsed.credential),
    Buffer.from(parsed.credential, "utf8").toString("base64"),
  ]);
  if (parsed.basic) {
    for (const component of [
      parsed.basic.decoded,
      parsed.basic.password,
    ]) {
      candidates.add(component);
      candidates.add(encodeURIComponent(component));
    }
  }
  return [...candidates].filter((candidate) => candidate.length > 0)
    .sort((left, right) => right.length - left.length);
}

function redactCredentialPatterns(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/\b(authorization|api[_-]?key|client[_-]?secret|password|access[_-]?token|refresh[_-]?token|cookie)=([^\s&;]+)/gi, "$1=[REDACTED]");
}

function redactRemoteString(value: string, exactSecrets: readonly string[]): string {
  let redacted = value;
  for (const secret of exactSecrets) redacted = redacted.split(secret).join("[REDACTED]");
  return redactCredentialPatterns(redacted);
}

function redactSensitiveRemoteValue(value: unknown, exactSecrets: readonly string[]): unknown {
  if (typeof value === "string") return redactRemoteString(value, exactSecrets);
  if (Array.isArray(value)) return value.map((item) => redactSensitiveRemoteValue(item, exactSecrets));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const safeKey = redactRemoteString(key, exactSecrets);
    if (Object.prototype.hasOwnProperty.call(output, safeKey)) {
      // Redaction can collapse attacker-controlled names; never overwrite one value with another.
      throw new RemoteMcpActionIndeterminateError();
    }
    Object.defineProperty(output, safeKey, {
      value: SENSITIVE_RESULT_KEY.test(key)
        ? "[REDACTED]"
        : redactSensitiveRemoteValue(item, exactSecrets),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return output;
}

/**
 * Executes a namespaced remote action only after the live server still matches the call's
 * immutable manifest. The caller's run_action receipt owns exactly-once admission.
 */
export async function invokePinnedExternalMcpTool(
  orgId: string,
  manifest: PinnedExternalMcpManifest,
  namespacedName: string,
  args: Record<string, unknown>,
  context: RemoteMcpInvocationContext,
  deps: RemoteMcpRuntimeDependencies = {}
): Promise<RemoteMcpToolInvocationOutcome> {
  if (!/^[A-Za-z0-9_-]{24}$/.test(context.invocationId) ||
      !/^[a-f0-9]{64}$/.test(context.idempotencyKey)) {
    return {
      outcome: "rejected",
      acknowledged: false,
      error: "The remote MCP invocation context is invalid.",
      code: "remote_mcp_invocation_context_invalid",
    };
  }
  const tool = manifest.tools.find((candidate) => candidate.name === namespacedName);
  if (!tool) {
    return {
      outcome: "rejected",
      acknowledged: false,
      error: "The remote MCP action is not present in the pinned catalog.",
      code: "remote_mcp_tool_not_pinned",
    };
  }
  const invalidArguments = validatePinnedExternalMcpArguments(manifest, namespacedName, args);
  if (invalidArguments) {
    return { outcome: "rejected", acknowledged: false, ...invalidArguments };
  }
  const operation = new AbortController();
  const deadline = setTimeout(() => operation.abort(), REMOTE_MCP_ACTION_TIMEOUT_MS);
  let verified: VerifiedRemoteMcp;
  try {
    verified = await openVerifiedRemoteMcp(manifest, orgId, deps, {
      signal: operation.signal,
      timeoutMs: REMOTE_MCP_REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    clearTimeout(deadline);
    if (error instanceof RemoteMcpPreflightError) {
      return {
        outcome: "rejected",
        acknowledged: false,
        error: error.message,
        code: error.code,
      };
    }
    return {
      outcome: "rejected",
      acknowledged: false,
      error: "The pinned remote MCP server is unavailable.",
      code: "remote_mcp_unavailable",
    };
  }
  try {
    // Discovery can take several network round trips. Re-read the exact tenant/revision latch
    // after that setup and at the last possible point before tools/call, so a cutoff committed
    // during initialize/listTools cannot leak one final mutating dispatch.
    try {
      await loadPinnedRegistryRevision(manifest, orgId, deps);
    } catch (error) {
      if (error instanceof RemoteMcpPreflightError) {
        return {
          outcome: "rejected",
          acknowledged: false,
          error: error.message,
          code: error.code,
        };
      }
      return {
        outcome: "rejected",
        acknowledged: false,
        error: "The pinned remote MCP server is unavailable.",
        code: "remote_mcp_unavailable",
      };
    }
    let result: McpToolCallResult;
    try {
      result = await verified.client.callTool(tool.remoteName, args, {
        signal: operation.signal,
        timeoutMs: REMOTE_MCP_TOOL_TIMEOUT_MS,
        metadata: {
          "hacc/invocation_id": context.invocationId,
          "hacc/idempotency_key": context.idempotencyKey,
        },
      });
    } catch {
      throw new RemoteMcpActionIndeterminateError();
    }
    if (result.isError) {
      // MCP isError has no standard proof that a mutating tool made zero downstream changes.
      // Preserve the receipt for reconciliation instead of freeing its idempotency key.
      throw new RemoteMcpActionIndeterminateError();
    }
    const sanitized = redactSensitiveRemoteValue(
      result.value,
      exactSecretRepresentations(verified.authorization)
    );
    // The value admitted to the receipt is the sanitized value. Validating an earlier secret-
    // bearing shape could commit a value whose type/required fields changed during redaction.
    if (!validatePinnedSchema(tool, "output", sanitized)) throw new RemoteMcpActionIndeterminateError();
    return Object.freeze({
      outcome: "succeeded" as const,
      acknowledged: true as const,
      value: sanitized,
    });
  } finally {
    clearTimeout(deadline);
    await closeQuietly(verified.client);
  }
}

/** Used by run_action before it writes a receipt; null means safe and schema-valid. */
export function validatePinnedExternalMcpArguments(
  manifest: PinnedExternalMcpManifest,
  namespacedName: string,
  args: Record<string, unknown>
): { error: string; code: string } | null {
  const tool = manifest.tools.find((candidate) => candidate.name === namespacedName);
  if (!tool) {
    return { error: "The remote MCP action is not present in the pinned catalog.", code: "remote_mcp_tool_not_pinned" };
  }
  if (!isBoundedGatewayJson(args)) {
    return { error: "Remote MCP action arguments exceed the safe JSON limits.", code: "remote_mcp_invalid_arguments" };
  }
  try {
    return validatePinnedSchema(tool, "input", args)
      ? null
      : { error: "Remote MCP action arguments do not match the pinned schema.", code: "remote_mcp_invalid_arguments" };
  } catch {
    return { error: "The pinned remote MCP schema is invalid.", code: "remote_mcp_schema_drift" };
  }
}
