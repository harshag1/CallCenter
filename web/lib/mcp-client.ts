// Server-side, fail-closed MCP Streamable HTTP client.
// Secrets are accepted only as an Authorization header and are never exposed in
// results, error messages, or logs. This module intentionally has no logger.

import { createHash } from "node:crypto";

export const MCP_LATEST_PROTOCOL_VERSION = "2025-11-25";
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = [
  MCP_LATEST_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
] as const;

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_TOOL_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_MAX_TOOLS = 10_000;
const DEFAULT_MAX_SSE_RESUMPTIONS = 3;
const MAX_SSE_RETRY_MS = 5_000;
const CANCELLATION_TIMEOUT_MS = 500;
const MAX_SESSION_ID_BYTES = 4_096;
const MAX_CURSOR_BYTES = 16_384;
const MAX_JSON_DEPTH = 40;
const MAX_JSON_NODES = 100_000;
const MAX_CONTENT_ITEMS = 1_000;
const MAX_TOOL_NAME_LENGTH = 128;
const DEFAULT_NAMESPACED_TOOL_NAME_LENGTH = 64;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export type McpJsonPrimitive = string | number | boolean | null;
export type McpJsonValue =
  | McpJsonPrimitive
  | McpJsonValue[]
  | { [key: string]: McpJsonValue };

export type McpToolDefinition = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, McpJsonValue>;
  outputSchema?: Record<string, McpJsonValue>;
};

export type NamespacedMcpToolDefinition = Omit<McpToolDefinition, "name"> & {
  name: string;
  remoteName: string;
  namespace: string;
};

export type McpTextContent = { type: "text"; text: string };
export type McpBinaryContent = {
  type: "image" | "audio";
  data: string;
  mimeType: string;
};
export type McpResourceLinkContent = {
  type: "resource_link";
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
};
export type McpEmbeddedResourceContent = {
  type: "resource";
  resource: {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  };
};
export type McpToolContent =
  | McpTextContent
  | McpBinaryContent
  | McpResourceLinkContent
  | McpEmbeddedResourceContent;

export type McpToolCallResult = {
  content: McpToolContent[];
  structuredContent?: Record<string, McpJsonValue>;
  isError: boolean;
  /** Structured output when present, otherwise parsed JSON text, plain text, or null. */
  value: McpJsonValue | string | null;
};

export type McpInitializeResult = {
  protocolVersion: string;
  serverInfo: { name: string; version: string; title?: string };
  capabilities: { tools: boolean; toolsListChanged: boolean };
};

export type McpFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export type McpRequestOptions = {
  signal?: AbortSignal;
  /** Total deadline for initialization plus the requested operation. */
  timeoutMs?: number;
};

export type StreamableHttpMcpClientOptions = {
  endpoint: string | URL;
  /** Full Authorization header value, for example `Bearer ...`. */
  authorization?: string;
  /** Omitted means all advertised tools; an explicitly empty list means none. */
  allowedTools?: Iterable<string>;
  fetch?: McpFetch;
  requestTimeoutMs?: number;
  toolCallTimeoutMs?: number;
  maxResponseBytes?: number;
  maxRequestBytes?: number;
  maxPages?: number;
  maxTools?: number;
  maxSseResumptions?: number;
  clientInfo?: { name: string; version: string };
  protocolVersion?: string;
  supportedProtocolVersions?: readonly string[];
  /** HTTP remains restricted to exact loopback hosts. Defaults to true for local development. */
  allowInsecureLocalhost?: boolean;
  /**
   * Optional deployment egress/SSRF policy, evaluated before every request.
   * Return false to fail closed. Use this for an origin allowlist or DNS/IP policy.
   */
  endpointPolicy?: (endpoint: URL) => boolean | Promise<boolean>;
};

export type McpClientErrorCode =
  | "invalid_configuration"
  | "insecure_endpoint"
  | "aborted"
  | "timeout"
  | "request_too_large"
  | "response_too_large"
  | "http_error"
  | "invalid_response"
  | "protocol_error"
  | "unsupported_protocol"
  | "missing_capability"
  | "tool_not_allowed"
  | "pagination_limit"
  | "session_expired"
  | "transport_error";

const ERROR_MESSAGES: Record<McpClientErrorCode, string> = {
  invalid_configuration: "The MCP client configuration is invalid.",
  insecure_endpoint: "The MCP endpoint must use HTTPS.",
  aborted: "The MCP operation was aborted.",
  timeout: "The MCP operation timed out.",
  request_too_large: "The MCP request exceeded the configured size limit.",
  response_too_large: "The MCP response exceeded the configured size limit.",
  http_error: "The MCP server returned an HTTP error.",
  invalid_response: "The MCP server returned an invalid response.",
  protocol_error: "The MCP server returned a JSON-RPC error.",
  unsupported_protocol: "The MCP server selected an unsupported protocol version.",
  missing_capability: "The MCP server did not declare the required capability.",
  tool_not_allowed: "The requested MCP tool is not allowed.",
  pagination_limit: "The MCP tool catalog exceeded a configured pagination limit.",
  session_expired: "The MCP session expired; retry with a newly initialized session.",
  transport_error: "The MCP transport failed.",
};

/** Deliberately excludes remote bodies, URLs, auth values, and nested causes. */
export class McpClientError extends Error {
  readonly code: McpClientErrorCode;
  readonly httpStatus?: number;
  readonly rpcCode?: number;

  constructor(
    code: McpClientErrorCode,
    metadata: { httpStatus?: number; rpcCode?: number } = {}
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = "McpClientError";
    this.code = code;
    this.httpStatus = metadata.httpStatus;
    this.rpcCode = metadata.rpcCode;
  }
}

type JsonRpcId = string | number;
type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: Record<string, McpJsonValue>;
};
type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, McpJsonValue>;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
};

type ParsedTransportResponse = {
  response: JsonRpcResponse;
  sessionId: string | null;
};

type McpTransportState = { protocolVersion: string; sessionId: string | null };

type JsonSanitizerState = {
  nodes: number;
  seen: WeakSet<object>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidResponse(): never {
  throw new McpClientError("invalid_response");
}

function configurationError(): never {
  throw new McpClientError("invalid_configuration");
}

function validPositiveInteger(value: number, max: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= max;
}

function assertNoHeaderInjection(value: string): void {
  if (!value || value.length > 8_192 || /[\u0000-\u001f\u007f]/.test(value)) {
    configurationError();
  }
}

function assertProtocolVersion(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) configurationError();
}

function assertToolName(value: unknown, configuration = false): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_TOOL_NAME_LENGTH ||
    !TOOL_NAME_PATTERN.test(value)
  ) {
    if (configuration) configurationError();
    invalidResponse();
  }
}

function safeString(
  value: unknown,
  maxLength: number,
  required: true
): string;
function safeString(
  value: unknown,
  maxLength: number,
  required?: false
): string | undefined;
function safeString(
  value: unknown,
  maxLength: number,
  required = false
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (
    typeof value !== "string" ||
    (required && value.length === 0) ||
    value.length > maxLength ||
    value.includes("\u0000")
  ) {
    invalidResponse();
  }
  return value;
}

function cloneJsonValue(
  value: unknown,
  state: JsonSanitizerState = { nodes: 0, seen: new WeakSet() },
  depth = 0
): McpJsonValue {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) invalidResponse();
  if (value === null) return null;
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidResponse();
    return value;
  }
  if (typeof value !== "object") invalidResponse();
  if (state.seen.has(value)) invalidResponse();
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => cloneJsonValue(item, state, depth + 1));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalidResponse();
    const output: Record<string, McpJsonValue> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") invalidResponse();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set) invalidResponse();
      if (!descriptor.enumerable) continue;
      // defineProperty avoids the legacy __proto__ setter while preserving JSON keys.
      Object.defineProperty(output, key, {
        value: cloneJsonValue(descriptor.value, state, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return output;
  } finally {
    state.seen.delete(value);
  }
}

function cloneJsonObject(value: unknown): Record<string, McpJsonValue> {
  if (!isRecord(value)) invalidResponse();
  return cloneJsonValue(value) as Record<string, McpJsonValue>;
}

function cloneRequestJsonObject(value: unknown): Record<string, McpJsonValue> {
  try {
    return cloneJsonObject(value);
  } catch {
    // Caller-controlled values must not leak thrown proxy/getter details either.
    throw new McpClientError("invalid_configuration");
  }
}

function canonicalBase64(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) return false;
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function safeMimeType(value: unknown, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (
    typeof value !== "string" ||
    value.length > 255 ||
    !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(value)
  ) {
    invalidResponse();
  }
  return value;
}

function parseContentItem(value: unknown): McpToolContent {
  if (!isRecord(value)) invalidResponse();
  switch (value.type) {
    case "text":
      return { type: "text", text: safeString(value.text, DEFAULT_MAX_RESPONSE_BYTES, true) };
    case "image":
    case "audio": {
      if (!canonicalBase64(value.data)) invalidResponse();
      return {
        type: value.type,
        data: value.data,
        mimeType: safeMimeType(value.mimeType, true) as string,
      };
    }
    case "resource_link":
      return {
        type: "resource_link",
        uri: safeString(value.uri, 16_384, true),
        name: safeString(value.name, 1_024, true),
        ...(value.title !== undefined ? { title: safeString(value.title, 1_024, true) } : {}),
        ...(value.description !== undefined
          ? { description: safeString(value.description, 16_384, true) }
          : {}),
        ...(value.mimeType !== undefined ? { mimeType: safeMimeType(value.mimeType, true) } : {}),
      };
    case "resource": {
      if (!isRecord(value.resource)) invalidResponse();
      const text = value.resource.text;
      const blob = value.resource.blob;
      if ((text === undefined) === (blob === undefined)) invalidResponse();
      if (blob !== undefined && !canonicalBase64(blob)) invalidResponse();
      return {
        type: "resource",
        resource: {
          uri: safeString(value.resource.uri, 16_384, true),
          ...(value.resource.mimeType !== undefined
            ? { mimeType: safeMimeType(value.resource.mimeType, true) }
            : {}),
          ...(text !== undefined
            ? { text: safeString(text, DEFAULT_MAX_RESPONSE_BYTES, true) }
            : { blob: blob as string }),
        },
      };
    }
    default:
      invalidResponse();
  }
}

/**
 * Extracts only spec-defined content. Unknown blocks and malformed binary data
 * fail closed; `_meta`, annotations, and arbitrary extension fields are dropped.
 */
export function extractSafeMcpToolResult(value: unknown): McpToolCallResult {
  if (!isRecord(value) || !Array.isArray(value.content) || value.content.length > MAX_CONTENT_ITEMS) {
    invalidResponse();
  }
  const content = value.content.map(parseContentItem);
  const structuredContent = value.structuredContent === undefined
    ? undefined
    : cloneJsonObject(value.structuredContent);
  const result: Omit<McpToolCallResult, "value"> = {
    content,
    isError: value.isError === undefined ? false : value.isError === true
      ? true
      : value.isError === false
      ? false
      : invalidResponse(),
    ...(structuredContent ? { structuredContent } : {}),
  };
  return { ...result, value: extractMcpResultValue(result) };
}

/** Prefer structured output, then JSON text, then bounded plain text. */
export function extractMcpResultValue(
  result: Pick<McpToolCallResult, "content" | "structuredContent">
): McpJsonValue | string | null {
  if (result.structuredContent) return cloneJsonObject(result.structuredContent);
  const text = result.content
    .filter((item): item is McpTextContent => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  if (!text) return null;
  if (text.length <= DEFAULT_MAX_RESPONSE_BYTES) {
    try {
      return cloneJsonValue(JSON.parse(text));
    } catch (error) {
      if (error instanceof McpClientError) throw error;
      // Plain text is a valid MCP result; JSON parsing is only a convenience.
    }
  }
  return text;
}

function parseTool(value: unknown): McpToolDefinition {
  if (!isRecord(value)) invalidResponse();
  assertToolName(value.name);
  const inputSchema = cloneJsonObject(value.inputSchema);
  const outputSchema = value.outputSchema === undefined
    ? undefined
    : cloneJsonObject(value.outputSchema);
  return {
    name: value.name,
    ...(value.title !== undefined ? { title: safeString(value.title, 1_024, true) } : {}),
    ...(value.description !== undefined
      ? { description: safeString(value.description, 32_768, true) }
      : {}),
    inputSchema,
    ...(outputSchema ? { outputSchema } : {}),
  };
}

function slugFragment(value: string, fallback: string): string {
  const slug = value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return slug || fallback;
}

/**
 * Produces provider-safe, deterministic names while retaining a hash of the
 * exact namespace/tool pair so lossy slug normalization cannot collide.
 */
export function namespaceMcpToolName(
  namespace: string,
  remoteName: string,
  maxLength = DEFAULT_NAMESPACED_TOOL_NAME_LENGTH
): string {
  if (!namespace || namespace.length > 1_024) configurationError();
  assertToolName(remoteName, true);
  if (!validPositiveInteger(maxLength, MAX_TOOL_NAME_LENGTH) || maxLength < 24) configurationError();
  const digest = createHash("sha256")
    .update(namespace)
    .update("\u0000")
    .update(remoteName)
    .digest("hex")
    .slice(0, 10);
  const prefix = `mcp_${slugFragment(namespace, "server")}_${slugFragment(remoteName, "tool")}`;
  const room = maxLength - digest.length - 1;
  return `${prefix.slice(0, room)}_${digest}`;
}

export function namespaceMcpTools(
  namespace: string,
  tools: readonly McpToolDefinition[],
  maxLength = DEFAULT_NAMESPACED_TOOL_NAME_LENGTH
): NamespacedMcpToolDefinition[] {
  const names = new Set<string>();
  return tools.map((tool) => {
    const name = namespaceMcpToolName(namespace, tool.name, maxLength);
    if (names.has(name)) configurationError();
    names.add(name);
    return { ...tool, name, remoteName: tool.name, namespace };
  });
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((part) => part > 255)) return true;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224;
}

function isPrivateEndpointHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (LOCAL_HOSTS.has(host) || isPrivateIpv4(host)) return true;
  const unwrapped = host.replace(/^\[|\]$/g, "");
  if (unwrapped.includes(":")) {
    if (unwrapped.startsWith("::ffff:")) {
      const mapped = unwrapped.slice("::ffff:".length);
      if (isPrivateIpv4(mapped)) return true;
      const words = mapped.split(":");
      if (words.length === 2 && words.every((word) => /^[0-9a-f]{1,4}$/.test(word))) {
        const value = (Number.parseInt(words[0], 16) * 65_536) + Number.parseInt(words[1], 16);
        const ipv4 = [24, 16, 8, 0].map((shift) => Math.floor(value / (2 ** shift)) % 256).join(".");
        if (isPrivateIpv4(ipv4)) return true;
      }
    }
    return unwrapped === "::" || unwrapped === "::1" ||
      /^f[cd]/.test(unwrapped) || /^fe[89ab]/.test(unwrapped) || /^ff/.test(unwrapped);
  }
  return host.endsWith(".localhost") || host.endsWith(".local") ||
    host.endsWith(".internal") || host.endsWith(".home.arpa");
}

function endpointUrl(value: string | URL, allowInsecureLocalhost: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    configurationError();
  }
  if (url.username || url.password || url.hash) configurationError();
  if (url.protocol === "https:") {
    if (isPrivateEndpointHost(url.hostname) && !(
      allowInsecureLocalhost && LOCAL_HOSTS.has(url.hostname.toLowerCase())
    )) {
      throw new McpClientError("insecure_endpoint");
    }
    return url;
  }
  if (
    url.protocol === "http:" &&
    allowInsecureLocalhost &&
    LOCAL_HOSTS.has(url.hostname.toLowerCase())
  ) {
    return url;
  }
  throw new McpClientError("insecure_endpoint");
}

function parseJsonRpcResponse(value: unknown, expectedId: JsonRpcId): JsonRpcResponse {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || value.id !== expectedId) invalidResponse();
  const hasResult = Object.prototype.hasOwnProperty.call(value, "result");
  const hasError = Object.prototype.hasOwnProperty.call(value, "error");
  if (hasResult === hasError) invalidResponse();
  if (hasError) {
    if (
      !isRecord(value.error) ||
      !Number.isSafeInteger(value.error.code) ||
      typeof value.error.message !== "string"
    ) {
      invalidResponse();
    }
    return {
      jsonrpc: "2.0",
      id: expectedId,
      error: { code: value.error.code as number, message: value.error.message },
    };
  }
  return { jsonrpc: "2.0", id: expectedId, result: value.result };
}

function readChunkWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      void reader.cancel().catch(() => undefined);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      }
    );
  });
}

async function readBodyCapped(
  response: Response,
  maxBytes: number,
  signal: AbortSignal
): Promise<string> {
  const advertised = response.headers.get("content-length");
  if (advertised && /^\d+$/.test(advertised) && Number(advertised) > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new McpClientError("response_too_large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await readChunkWithSignal(reader, signal);
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new McpClientError("response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalidResponse();
  }
}

type SseReadResult = {
  message?: unknown;
  lastEventId?: string;
  retryMs?: number;
  bytesRead: number;
};

async function readSseResponse(
  response: Response,
  expectedId: JsonRpcId,
  maxBytes: number,
  signal: AbortSignal,
  onOutOfBand: (message: unknown) => void
): Promise<SseReadResult> {
  if (!response.body) invalidResponse();
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let bytesRead = 0;
  let data: string[] = [];
  let lastEventId: string | undefined;
  let eventIdSeen = false;
  let eventIdValue: string | undefined;
  let retryMs: number | undefined;
  let firstLine = true;

  const dispatch = (): unknown | undefined => {
    if (eventIdSeen) lastEventId = eventIdValue;
    eventIdSeen = false;
    eventIdValue = undefined;
    if (!data.length) return undefined;
    const payload = data.join("\n");
    data = [];
    if (!payload) return undefined;
    let candidate: unknown;
    try {
      candidate = JSON.parse(payload);
    } catch {
      invalidResponse();
    }
    if (isRecord(candidate) && typeof candidate.method === "string") {
      onOutOfBand(candidate);
      return undefined;
    }
    if (isRecord(candidate) && candidate.id === expectedId) return candidate;
    onOutOfBand(candidate);
    return undefined;
  };
  const consumeLine = (rawLine: string): unknown | undefined => {
    let line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (firstLine) {
      line = line.replace(/^\uFEFF/, "");
      firstLine = false;
    }
    if (!line) return dispatch();
    if (line.startsWith(":")) return undefined;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "id") {
      eventIdSeen = true;
      if (!value) eventIdValue = undefined;
      else {
        if (!/^[\x21-\x7e]+$/.test(value) || value.length > MAX_CURSOR_BYTES) invalidResponse();
        eventIdValue = value;
      }
    } else if (field === "retry" && /^\d+$/.test(value)) {
      retryMs = Math.min(Number(value), MAX_SSE_RETRY_MS);
    }
    return undefined;
  };

  try {
    while (true) {
      const { done, value } = await readChunkWithSignal(reader, signal);
      if (done) {
        buffer += decoder.decode();
        break;
      }
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new McpClientError("response_too_large");
      }
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const message = consumeLine(line);
        if (message !== undefined) {
          void reader.cancel().catch(() => undefined);
          return { message, lastEventId, retryMs, bytesRead };
        }
      }
    }
    if (buffer) {
      const message = consumeLine(buffer);
      if (message !== undefined) return { message, lastEventId, retryMs, bytesRead };
    }
    // A disconnect before the blank event boundary must not advance the cursor.
    return { lastEventId, retryMs, bytesRead };
  } catch (error) {
    if (error instanceof TypeError && !signal.aborted) invalidResponse();
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function validateSessionId(value: string | null): string | null {
  if (value === null) return null;
  if (
    value.length < 1 ||
    new TextEncoder().encode(value).byteLength > MAX_SESSION_ID_BYTES ||
    !/^[\x21-\x7e]+$/.test(value)
  ) {
    invalidResponse();
  }
  return value;
}

function parseInitializeResult(
  value: unknown,
  supportedVersions: ReadonlySet<string>
): McpInitializeResult {
  if (!isRecord(value)) invalidResponse();
  const protocolVersion = safeString(value.protocolVersion, 32, true);
  if (!supportedVersions.has(protocolVersion)) {
    throw new McpClientError("unsupported_protocol");
  }
  if (!isRecord(value.serverInfo) || !isRecord(value.capabilities)) invalidResponse();
  const tools = value.capabilities.tools;
  if (tools !== undefined && !isRecord(tools)) invalidResponse();
  return {
    protocolVersion,
    serverInfo: {
      name: safeString(value.serverInfo.name, 1_024, true),
      version: safeString(value.serverInfo.version, 1_024, true),
      ...(value.serverInfo.title !== undefined
        ? { title: safeString(value.serverInfo.title, 1_024, true) }
        : {}),
    },
    capabilities: {
      tools: tools !== undefined,
      toolsListChanged: isRecord(tools) && tools.listChanged === true,
    },
  };
}

function makeOperationSignal(
  external: AbortSignal | undefined,
  timeoutMs: number
): {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
} {
  if (!validPositiveInteger(timeoutMs, 3_600_000)) configurationError();
  const controller = new AbortController();
  let timeoutReached = false;
  const onAbort = () => controller.abort();
  if (external?.aborted) controller.abort();
  else external?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timeoutReached = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
  };
}

function waitForPromiseWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      }
    );
  });
}

export class StreamableHttpMcpClient {
  readonly #endpoint: URL;
  readonly #authorization?: string;
  readonly #allowedTools?: ReadonlySet<string>;
  readonly #fetch: McpFetch;
  readonly #requestTimeoutMs: number;
  readonly #toolCallTimeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #maxRequestBytes: number;
  readonly #maxPages: number;
  readonly #maxTools: number;
  readonly #maxSseResumptions: number;
  readonly #endpointPolicy?: (endpoint: URL) => boolean | Promise<boolean>;
  readonly #clientInfo: { name: string; version: string };
  readonly #requestedProtocolVersion: string;
  readonly #supportedProtocolVersions: ReadonlySet<string>;
  #nextRequestId = 1;
  #sessionId: string | null = null;
  #initializeResult: McpInitializeResult | null = null;
  #initializePromise: Promise<McpInitializeResult> | null = null;
  #initializeController: AbortController | null = null;
  #initializationRefs = new Map<Promise<McpInitializeResult>, {
    controller: AbortController;
    waiters: number;
  }>();
  #advertisedTools: ReadonlySet<string> | null = null;
  #lifecycleGeneration = 0;

  constructor(options: StreamableHttpMcpClientOptions) {
    const allowInsecureLocalhost = process.env.NODE_ENV !== "production"
      && (options.allowInsecureLocalhost ?? true);
    this.#endpoint = endpointUrl(options.endpoint, allowInsecureLocalhost);
    if (options.authorization !== undefined) {
      assertNoHeaderInjection(options.authorization);
      this.#authorization = options.authorization;
    }
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    if (typeof this.#fetch !== "function") configurationError();
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#toolCallTimeoutMs = options.toolCallTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.#maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    this.#maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    this.#maxTools = options.maxTools ?? DEFAULT_MAX_TOOLS;
    this.#maxSseResumptions = options.maxSseResumptions ?? DEFAULT_MAX_SSE_RESUMPTIONS;
    if (options.endpointPolicy !== undefined && typeof options.endpointPolicy !== "function") {
      configurationError();
    }
    if (process.env.NODE_ENV === "production" && !options.endpointPolicy) configurationError();
    this.#endpointPolicy = options.endpointPolicy;
    if (
      !validPositiveInteger(this.#requestTimeoutMs, 3_600_000) ||
      !validPositiveInteger(this.#toolCallTimeoutMs, 3_600_000) ||
      !validPositiveInteger(this.#maxResponseBytes, 64 * 1024 * 1024) ||
      !validPositiveInteger(this.#maxRequestBytes, 16 * 1024 * 1024) ||
      !validPositiveInteger(this.#maxPages, 10_000) ||
      !validPositiveInteger(this.#maxTools, 1_000_000) ||
      !validPositiveInteger(this.#maxSseResumptions, 100)
    ) {
      configurationError();
    }

    const supported = options.supportedProtocolVersions ?? MCP_SUPPORTED_PROTOCOL_VERSIONS;
    if (!supported.length) configurationError();
    for (const version of supported) assertProtocolVersion(version);
    this.#supportedProtocolVersions = new Set(supported);
    this.#requestedProtocolVersion = options.protocolVersion ?? MCP_LATEST_PROTOCOL_VERSION;
    assertProtocolVersion(this.#requestedProtocolVersion);
    if (!this.#supportedProtocolVersions.has(this.#requestedProtocolVersion)) configurationError();

    const clientInfo = options.clientInfo ?? {
      name: "harshas-amazing-call-center",
      version: "1.0.0",
    };
    if (
      !clientInfo.name ||
      clientInfo.name.length > 1_024 ||
      !clientInfo.version ||
      clientInfo.version.length > 1_024 ||
      /[\u0000-\u001f\u007f]/.test(clientInfo.name + clientInfo.version)
    ) {
      configurationError();
    }
    this.#clientInfo = { ...clientInfo };

    if (options.allowedTools !== undefined) {
      const allowed = new Set<string>();
      try {
        for (const name of options.allowedTools) {
          assertToolName(name, true);
          allowed.add(name);
          if (allowed.size > this.#maxTools) configurationError();
        }
      } catch {
        configurationError();
      }
      this.#allowedTools = allowed;
    }
  }

  async #runOperation<T>(
    options: McpRequestOptions,
    defaultTimeoutMs: number,
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const operationSignal = makeOperationSignal(
      options.signal,
      options.timeoutMs ?? defaultTimeoutMs
    );
    try {
      return await operation(operationSignal.signal);
    } catch (error) {
      if (options.signal?.aborted) throw new McpClientError("aborted");
      if (operationSignal.timedOut()) throw new McpClientError("timeout");
      if (operationSignal.signal.aborted) throw new McpClientError("aborted");
      if (error instanceof McpClientError) throw error;
      throw new McpClientError("transport_error");
    } finally {
      operationSignal.cleanup();
    }
  }

  #headers(initializing = false, transportState?: McpTransportState): Headers {
    const headers = new Headers({
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    });
    if (this.#authorization) headers.set("Authorization", this.#authorization);
    const state = transportState ?? (!initializing && this.#initializeResult
      ? { protocolVersion: this.#initializeResult.protocolVersion, sessionId: this.#sessionId }
      : null);
    if (state) {
      headers.set("MCP-Protocol-Version", state.protocolVersion);
      if (state.sessionId) headers.set("MCP-Session-Id", state.sessionId);
    }
    return headers;
  }

  async #assertEndpointPolicy(signal: AbortSignal): Promise<void> {
    if (!this.#endpointPolicy) return;
    let accepted: boolean;
    try {
      accepted = await waitForPromiseWithSignal(
        Promise.resolve(this.#endpointPolicy(new URL(this.#endpoint))),
        signal
      );
    } catch (error) {
      if (signal.aborted) throw error;
      throw new McpClientError("insecure_endpoint");
    }
    if (!accepted) throw new McpClientError("insecure_endpoint");
  }

  async #fetchResponse(
    body: string,
    signal: AbortSignal,
    initializing: boolean,
    transportState?: McpTransportState
  ): Promise<Response> {
    if (new TextEncoder().encode(body).byteLength > this.#maxRequestBytes) {
      throw new McpClientError("request_too_large");
    }
    await this.#assertEndpointPolicy(signal);
    try {
      return await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: this.#headers(initializing, transportState),
        body,
        signal,
        redirect: "error",
        cache: "no-store",
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new McpClientError("transport_error");
    }
  }

  #expireSession(): void {
    this.#sessionId = null;
    this.#initializeResult = null;
    this.#initializePromise = null;
    this.#advertisedTools = null;
    this.#lifecycleGeneration += 1;
  }

  async #requireSuccessfulResponse(response: Response): Promise<void> {
    if (response.ok) return;
    void response.body?.cancel().catch(() => undefined);
    if (response.status === 404 && this.#sessionId) {
      this.#expireSession();
      throw new McpClientError("session_expired", { httpStatus: 404 });
    }
    throw new McpClientError("http_error", { httpStatus: response.status });
  }

  async #resumeSse(
    lastEventId: string,
    signal: AbortSignal,
    state: McpTransportState
  ): Promise<Response> {
    await this.#assertEndpointPolicy(signal);
    const headers = this.#headers(false, state);
    headers.delete("Content-Type");
    headers.set("Accept", "text/event-stream");
    headers.set("Last-Event-ID", lastEventId);
    try {
      return await this.#fetch(this.#endpoint, {
        method: "GET",
        headers,
        signal,
        redirect: "error",
        cache: "no-store",
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new McpClientError("transport_error");
    }
  }

  #handleSseOutOfBand(message: unknown, state: McpTransportState): void {
    if (!isRecord(message) || message.jsonrpc !== "2.0") invalidResponse();
    if (message.method === "notifications/tools/list_changed" && message.id === undefined) {
      this.#advertisedTools = null;
      return;
    }
    if (typeof message.method !== "string" ||
        (typeof message.id !== "string" && typeof message.id !== "number")) {
      return;
    }
    const response = message.method === "ping"
      ? { jsonrpc: "2.0", id: message.id, result: {} }
      : {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Method not found" },
        };
    const reply = makeOperationSignal(undefined, CANCELLATION_TIMEOUT_MS);
    void (async () => {
      try {
        const http = await this.#fetchResponse(
          JSON.stringify(response),
          reply.signal,
          false,
          state
        );
        if (http.status !== 202 && http.status !== 204) {
          void http.body?.cancel().catch(() => undefined);
          return;
        }
        void http.body?.cancel().catch(() => undefined);
      } finally {
        reply.cleanup();
      }
    })().catch(() => undefined);
  }

  async #postRequest(
    request: JsonRpcRequest,
    signal: AbortSignal,
    initializing = false
  ): Promise<ParsedTransportResponse> {
    const response = await this.#fetchResponse(JSON.stringify(request), signal, initializing);
    await this.#requireSuccessfulResponse(response);
    const sessionId = initializing
      ? validateSessionId(response.headers.get("mcp-session-id"))
      : null;
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json" && contentType !== "text/event-stream") {
      void response.body?.cancel().catch(() => undefined);
      invalidResponse();
    }
    if (contentType === "application/json") {
      const body = await readBodyCapped(response, this.#maxResponseBytes, signal);
      let candidate: unknown;
      try {
        candidate = JSON.parse(body);
      } catch {
        invalidResponse();
      }
      return {
        response: parseJsonRpcResponse(candidate, request.id),
        sessionId,
      };
    }

    const state: McpTransportState = initializing
      ? { protocolVersion: this.#requestedProtocolVersion, sessionId }
      : {
          protocolVersion: this.#initializeResult?.protocolVersion ?? this.#requestedProtocolVersion,
          sessionId: this.#sessionId,
        };
    let current = response;
    let remainingBytes = this.#maxResponseBytes;
    for (let resume = 0; resume <= this.#maxSseResumptions; resume += 1) {
      await this.#requireSuccessfulResponse(current);
      const resumedType = current.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      if (resumedType !== "text/event-stream") {
        void current.body?.cancel().catch(() => undefined);
        invalidResponse();
      }
      const advertised = current.headers.get("content-length");
      if (advertised && /^\d+$/.test(advertised) && Number(advertised) > remainingBytes) {
        void current.body?.cancel().catch(() => undefined);
        throw new McpClientError("response_too_large");
      }
      const event = await readSseResponse(
        current,
        request.id,
        remainingBytes,
        signal,
        (message) => this.#handleSseOutOfBand(message, state)
      );
      remainingBytes -= event.bytesRead;
      if (event.message !== undefined) {
        return { response: parseJsonRpcResponse(event.message, request.id), sessionId };
      }
      if (!event.lastEventId || resume === this.#maxSseResumptions) invalidResponse();
      await abortableDelay(event.retryMs ?? 0, signal);
      current = await this.#resumeSse(event.lastEventId, signal, state);
    }
    invalidResponse();
  }

  async #postNotification(
    notification: JsonRpcNotification,
    signal: AbortSignal,
    transportState?: McpTransportState
  ): Promise<void> {
    const response = await this.#fetchResponse(
      JSON.stringify(notification),
      signal,
      false,
      transportState
    );
    if (response.status !== 202 && response.status !== 204) {
      void response.body?.cancel().catch(() => undefined);
      throw new McpClientError("http_error", { httpStatus: response.status });
    }
    const body = await readBodyCapped(response, this.#maxResponseBytes, signal);
    if (body.length !== 0) invalidResponse();
  }

  async #rpc(
    method: string,
    params: Record<string, McpJsonValue> | undefined,
    signal: AbortSignal,
    initializing = false
  ): Promise<{ result: unknown; sessionId: string | null }> {
    const id = this.#nextRequestId++;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };
    let transport: ParsedTransportResponse;
    try {
      transport = await this.#postRequest(request, signal, initializing);
    } catch (error) {
      if (signal.aborted && !initializing && this.#initializeResult) {
        await this.#sendCancellation(id).catch(() => undefined);
      }
      throw error;
    }
    if (transport.response.error) {
      throw new McpClientError("protocol_error", {
        rpcCode: transport.response.error.code,
      });
    }
    return { result: transport.response.result, sessionId: transport.sessionId };
  }

  async #sendCancellation(requestId: JsonRpcId): Promise<void> {
    if (!this.#initializeResult) return;
    const cancellation = makeOperationSignal(undefined, CANCELLATION_TIMEOUT_MS);
    try {
      await this.#postNotification({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId, reason: "client request ended" },
      }, cancellation.signal);
    } finally {
      cancellation.cleanup();
    }
  }

  async #initializeCore(signal: AbortSignal): Promise<McpInitializeResult> {
    if (this.#initializeResult) return this.#initializeResult;
    if (!this.#initializePromise) {
      const generation = this.#lifecycleGeneration;
      const controller = new AbortController();
      const internal = makeOperationSignal(controller.signal, this.#requestTimeoutMs);
      this.#initializeController = controller;
      const promise = (async () => {
        try {
          const response = await this.#rpc(
            "initialize",
            {
              protocolVersion: this.#requestedProtocolVersion,
              capabilities: {},
              clientInfo: {
                name: this.#clientInfo.name,
                version: this.#clientInfo.version,
              },
            },
            internal.signal,
            true
          );
          const initialized = parseInitializeResult(
            response.result,
            this.#supportedProtocolVersions
          );
          const transportState = {
            protocolVersion: initialized.protocolVersion,
            sessionId: response.sessionId,
          };
          await this.#postNotification(
            { jsonrpc: "2.0", method: "notifications/initialized" },
            internal.signal,
            transportState
          );
          if (generation !== this.#lifecycleGeneration) {
            throw new McpClientError("aborted");
          }
          // Publish the session atomically only after the lifecycle handshake completes.
          this.#sessionId = response.sessionId;
          this.#initializeResult = initialized;
          return initialized;
        } catch (error) {
          if (internal.timedOut()) throw new McpClientError("timeout");
          if (controller.signal.aborted) throw new McpClientError("aborted");
          throw error;
        } finally {
          internal.cleanup();
          if (this.#initializeController === controller) this.#initializeController = null;
        }
      })();
      this.#initializePromise = promise;
      this.#initializationRefs.set(promise, { controller, waiters: 0 });
      void promise.finally(() => {
        if (this.#initializePromise === promise) this.#initializePromise = null;
        this.#initializationRefs.delete(promise);
      }).catch(() => undefined);
    }
    const pending = this.#initializePromise;
    const reference = this.#initializationRefs.get(pending);
    if (!reference) throw new McpClientError("transport_error");
    reference.waiters += 1;
    try {
      return await waitForPromiseWithSignal(pending, signal);
    } finally {
      reference.waiters -= 1;
      if (reference.waiters === 0 && !this.#initializeResult) {
        reference.controller.abort();
        if (this.#initializePromise === pending) {
          this.#initializeController = null;
          this.#initializePromise = null;
        }
      }
    }
  }

  initialize(options: McpRequestOptions = {}): Promise<McpInitializeResult> {
    return this.#runOperation(options, this.#requestTimeoutMs, (signal) =>
      this.#initializeCore(signal)
    );
  }

  async #listToolsCore(signal: AbortSignal): Promise<McpToolDefinition[]> {
    const initialized = await this.#initializeCore(signal);
    if (!initialized.capabilities.tools) throw new McpClientError("missing_capability");
    const output: McpToolDefinition[] = [];
    const remoteNames = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let remoteToolCount = 0;
    for (let page = 0; page < this.#maxPages; page += 1) {
      const response = await this.#rpc(
        "tools/list",
        cursor === undefined ? undefined : { cursor },
        signal
      );
      if (!isRecord(response.result) || !Array.isArray(response.result.tools)) invalidResponse();
      remoteToolCount += response.result.tools.length;
      if (remoteToolCount > this.#maxTools) throw new McpClientError("pagination_limit");
      for (const candidate of response.result.tools) {
        const tool = parseTool(candidate);
        if (remoteNames.has(tool.name)) invalidResponse();
        remoteNames.add(tool.name);
        if (!this.#allowedTools || this.#allowedTools.has(tool.name)) output.push(tool);
      }
      const nextCursor = response.result.nextCursor;
      if (nextCursor === undefined || nextCursor === null) {
        this.#advertisedTools = remoteNames;
        return output;
      }
      if (
        typeof nextCursor !== "string" ||
        nextCursor.length === 0 ||
        new TextEncoder().encode(nextCursor).byteLength > MAX_CURSOR_BYTES ||
        cursors.has(nextCursor)
      ) {
        throw new McpClientError("pagination_limit");
      }
      cursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new McpClientError("pagination_limit");
  }

  listTools(options: McpRequestOptions = {}): Promise<McpToolDefinition[]> {
    return this.#runOperation(options, this.#requestTimeoutMs, (signal) =>
      this.#listToolsCore(signal)
    );
  }

  callTool(
    name: string,
    args: Record<string, unknown> = {},
    options: McpRequestOptions = {}
  ): Promise<McpToolCallResult> {
    assertToolName(name, true);
    if (this.#allowedTools && !this.#allowedTools.has(name)) {
      return Promise.reject(new McpClientError("tool_not_allowed"));
    }
    const safeArgs = cloneRequestJsonObject(args);
    return this.#runOperation(options, this.#toolCallTimeoutMs, async (signal) => {
      const initialized = await this.#initializeCore(signal);
      if (!initialized.capabilities.tools) throw new McpClientError("missing_capability");
      if (!this.#allowedTools) {
        if (!this.#advertisedTools) await this.#listToolsCore(signal);
        if (!this.#advertisedTools?.has(name)) throw new McpClientError("tool_not_allowed");
      }
      const response = await this.#rpc(
        "tools/call",
        { name, arguments: safeArgs },
        signal
      );
      return extractSafeMcpToolResult(response.result);
    });
  }

  /** Ends a stateful HTTP session. HTTP 405 is allowed by the MCP transport. */
  close(options: McpRequestOptions = {}): Promise<void> {
    this.#lifecycleGeneration += 1;
    this.#initializeController?.abort();
    const sessionId = this.#sessionId;
    const initialized = this.#initializeResult;
    this.#sessionId = null;
    this.#initializeResult = null;
    this.#initializePromise = null;
    this.#initializeController = null;
    this.#advertisedTools = null;
    return this.#runOperation(options, this.#requestTimeoutMs, async (signal) => {
      if (!sessionId || !initialized) return;
      await this.#assertEndpointPolicy(signal);
      const headers = new Headers({
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": initialized.protocolVersion,
        "MCP-Session-Id": sessionId,
      });
      if (this.#authorization) headers.set("Authorization", this.#authorization);
      let response: Response;
      try {
        response = await this.#fetch(this.#endpoint, {
          method: "DELETE",
          headers,
          signal,
          redirect: "error",
          cache: "no-store",
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new McpClientError("transport_error");
      }
      if (![200, 202, 204, 405].includes(response.status)) {
        void response.body?.cancel().catch(() => undefined);
        throw new McpClientError("http_error", { httpStatus: response.status });
      }
      void response.body?.cancel().catch(() => undefined);
    });
  }
}
