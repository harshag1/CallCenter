import { createHash } from "node:crypto";
import type { RealtimeTransportFailureDiagnostic } from "./types";

const HASH_DOMAIN = "harshas-amazing-call-center/realtime-transport-diagnostic/v1";

const SAFE_RAW_CODES = new Set([
  "authentication_error",
  "connection_error",
  "content_filter",
  "insufficient_quota",
  "invalid_request",
  "invalid_request_error",
  "input_audio_buffer_commit_audio_too_short",
  "input_audio_buffer_commit_empty",
  "input_audio_buffer_too_small",
  "permission_denied",
  "rate_limit",
  "rate_limit_exceeded",
  "response_generation_failed",
  "safety_violation",
  "server_error",
  "service_unavailable",
  "session_expired",
  "timeout",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

type DiagnosticInput = Readonly<{
  origin: RealtimeTransportFailureDiagnostic["origin"];
  rawCode?: unknown;
  message?: unknown;
  reason?: unknown;
  closeCode?: unknown;
  responseGenerationRequested: boolean;
  responseGenerationStarted: boolean;
  responseTerminalObserved: boolean;
}>;

export function createRealtimeTransportFailureDiagnostic(
  input: DiagnosticInput,
): RealtimeTransportFailureDiagnostic {
  const rawCode = boundedText(input.rawCode);
  const message = boundedText(input.message);
  const reason = boundedCloseReason(input.reason);
  const closeCode = typeof input.closeCode === "number" && Number.isSafeInteger(input.closeCode)
    ? input.closeCode
    : undefined;
  const safeRawCode = rawCode !== undefined && SAFE_RAW_CODES.has(rawCode) ? rawCode : undefined;
  const result: RealtimeTransportFailureDiagnostic = {
    schemaVersion: 1,
    origin: input.origin,
    category: diagnosticCategory(input.origin, rawCode, closeCode),
    ...(safeRawCode === undefined ? {} : { safeRawCode }),
    ...(rawCode === undefined ? {} : { rawCodeSha256: diagnosticHash("raw-code", rawCode) }),
    ...(message === undefined ? {} : { messageSha256: diagnosticHash("message", message) }),
    ...(reason === undefined ? {} : { reasonSha256: diagnosticHash("reason", reason) }),
    ...(input.origin !== "websocket_close"
      ? {}
      : { closeCodeClass: closeCode === undefined ? "unknown" as const : closeCodeClass(closeCode) }),
    responseGenerationRequested: input.responseGenerationRequested,
    responseGenerationStarted: input.responseGenerationStarted,
    responseTerminalObserved: input.responseTerminalObserved,
  };
  return Object.freeze(result);
}

export function assertRealtimeTransportFailureDiagnostic(
  value: RealtimeTransportFailureDiagnostic,
): void {
  const origins = new Set(["provider_wire", "websocket_error", "websocket_close", "client_transport"]);
  const categories = new Set([
    "provider_authentication", "provider_quota", "provider_rate_limit", "provider_request",
    "provider_safety", "provider_service", "provider_protocol", "network", "tls",
    "websocket_protocol", "normal_close", "policy_close", "server_close",
    "application_close", "unknown",
  ]);
  const closeClasses = new Set([
    "normal", "going_away", "protocol_error", "unsupported_data", "abnormal",
    "invalid_payload", "policy_violation", "message_too_big", "extension_required",
    "server_error", "service_restart", "try_again_later", "bad_gateway", "registered",
    "private_use", "unknown",
  ]);
  const allowedKeys = new Set([
    "schemaVersion", "origin", "category", "safeRawCode", "rawCodeSha256",
    "messageSha256", "reasonSha256", "closeCodeClass", "responseGenerationRequested",
    "responseGenerationStarted", "responseTerminalObserved",
  ]);
  if (value.schemaVersion !== 1 || !origins.has(value.origin) || !categories.has(value.category)
    || Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error("Realtime transport diagnostic contains a non-allowlisted field or value");
  }
  if (value.safeRawCode !== undefined && !SAFE_RAW_CODES.has(value.safeRawCode)) {
    throw new Error("Realtime transport diagnostic exposes a non-allowlisted raw code");
  }
  if (value.safeRawCode !== undefined && value.rawCodeSha256 === undefined) {
    throw new Error("Realtime transport diagnostic safe raw code lacks its commitment");
  }
  for (const hash of [value.rawCodeSha256, value.messageSha256, value.reasonSha256]) {
    if (hash !== undefined && !/^[a-f0-9]{64}$/u.test(hash)) {
      throw new Error("Realtime transport diagnostic contains an invalid SHA-256");
    }
  }
  if (value.closeCodeClass !== undefined && !closeClasses.has(value.closeCodeClass)) {
    throw new Error("Realtime transport diagnostic close-code class is invalid");
  }
  if ((value.origin === "websocket_close") !== (value.closeCodeClass !== undefined)) {
    throw new Error("Realtime transport diagnostic close-code class has the wrong origin");
  }
  if ([value.responseGenerationRequested, value.responseGenerationStarted, value.responseTerminalObserved]
    .some((item) => typeof item !== "boolean")
    || (value.responseGenerationStarted && !value.responseGenerationRequested)
    || (value.responseTerminalObserved && !value.responseGenerationRequested)) {
    throw new Error("Realtime transport diagnostic response lifecycle is inconsistent");
  }
}

function boundedText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  // Hashing is content-free, but bound adversarial provider/socket inputs before
  // any diagnostic work. The provider wire parser already enforces a frame cap.
  return Buffer.byteLength(value, "utf8") <= 64 * 1024 ? value : value.slice(0, 64 * 1024);
}

function boundedCloseReason(value: unknown): string | undefined {
  if (typeof value === "string") return boundedText(value);
  if (value instanceof Uint8Array) return boundedText(Buffer.from(value).toString("utf8"));
  if (ArrayBuffer.isView(value)) {
    return boundedText(Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8"));
  }
  return undefined;
}

function diagnosticHash(field: "raw-code" | "message" | "reason", value: string): string {
  return createHash("sha256")
    .update(HASH_DOMAIN)
    .update("\0")
    .update(field)
    .update("\0")
    .update(value)
    .digest("hex");
}

function diagnosticCategory(
  origin: RealtimeTransportFailureDiagnostic["origin"],
  rawCode: string | undefined,
  closeCode: number | undefined,
): RealtimeTransportFailureDiagnostic["category"] {
  if (origin === "websocket_close") {
    if (closeCode === 1000 || closeCode === 1001) return "normal_close";
    if (closeCode === 1008) return "policy_close";
    if (closeCode !== undefined && (closeCode === 1011 || closeCode === 1012 || closeCode === 1013 || closeCode === 1014)) {
      return "server_close";
    }
    if (closeCode !== undefined && closeCode >= 3000 && closeCode <= 4999) return "application_close";
    if (closeCode !== undefined && [1002, 1003, 1007, 1009, 1010].includes(closeCode)) return "websocket_protocol";
    return "unknown";
  }
  const normalized = rawCode?.toLowerCase() ?? "";
  if (normalized.includes("quota")) return "provider_quota";
  if (normalized.includes("auth") || normalized.includes("permission")) return "provider_authentication";
  if (normalized.includes("rate_limit")) return "provider_rate_limit";
  if (normalized.includes("content_filter") || normalized.includes("safety")) return "provider_safety";
  if (normalized.includes("invalid_request") || normalized.startsWith("input_audio_buffer")) return "provider_request";
  if (normalized.includes("server") || normalized.includes("service_unavailable") || normalized === "timeout"
    || normalized === "response_generation_failed") return "provider_service";
  if (normalized.startsWith("err_tls") || normalized.includes("certificate") || normalized.includes("verify_leaf")) return "tls";
  if (["eai_again", "econnrefused", "econnreset", "enetunreach", "enotfound", "etimedout"].includes(normalized)) return "network";
  if (origin === "provider_wire") return "provider_protocol";
  if (origin === "websocket_error") return "network";
  return "unknown";
}

function closeCodeClass(code: number): NonNullable<RealtimeTransportFailureDiagnostic["closeCodeClass"]> {
  switch (code) {
    case 1000: return "normal";
    case 1001: return "going_away";
    case 1002: return "protocol_error";
    case 1003: return "unsupported_data";
    case 1005:
    case 1006: return "abnormal";
    case 1007: return "invalid_payload";
    case 1008: return "policy_violation";
    case 1009: return "message_too_big";
    case 1010: return "extension_required";
    case 1011: return "server_error";
    case 1012: return "service_restart";
    case 1013: return "try_again_later";
    case 1014: return "bad_gateway";
    default:
      if (code >= 3000 && code <= 3999) return "registered";
      if (code >= 4000 && code <= 4999) return "private_use";
      return "unknown";
  }
}
