import { randomUUID } from "node:crypto";

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const SAFE_TOOL = /^[a-z][a-z0-9_.-]{1,63}$/;

function required(env, name, minimumLength = 1) {
  const value = env[name];
  if (typeof value !== "string" || value.length < minimumLength) {
    throw new Error(`${name} is required${minimumLength > 1 ? ` and must contain at least ${minimumLength} characters` : ""}`);
  }
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error(`${name} contains control characters`);
  return value;
}

function optionalCredential(env, name) {
  const value = env[name];
  if (value === undefined || value === "") return null;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 8_192 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} must be a bounded control-free credential`);
  }
  return value;
}

function booleanEnv(env, name, fallback = false) {
  const value = env[name];
  if (value === undefined || value === "") return fallback;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new Error(`${name} must be 1, 0, true, or false`);
}

function integerEnv(env, name, fallback, minimum, maximum) {
  const value = env[name] === undefined || env[name] === "" ? fallback : Number(env[name]);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function originUrl(value, { allowInsecure }) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("APP_ORIGIN must be an origin without credentials, path, query, or fragment");
  }
  if (url.protocol !== "https:" && !(allowInsecure && url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("APP_ORIGIN must use https (http is allowed only for explicit loopback tests)");
  }
  return url.origin;
}

function streamUrl(value, { allowInsecure }) {
  if (value.includes("?") || value.includes("#") || value.includes("\\")) {
    throw new Error("BRIDGE_PUBLIC_STREAM_URL cannot contain a query, fragment, or backslash");
  }
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("BRIDGE_PUBLIC_STREAM_URL cannot contain credentials, query, or fragment");
  }
  if (url.protocol !== "wss:" && !(allowInsecure && url.protocol === "ws:" && isLoopback(url.hostname))) {
    throw new Error("BRIDGE_PUBLIC_STREAM_URL must use wss (ws is allowed only for explicit loopback tests)");
  }
  if (url.pathname !== "/stream") throw new Error("BRIDGE_PUBLIC_STREAM_URL path must be exactly /stream");
  const expectedPrefix = url.protocol === "wss:" ? "wss://" : "ws://";
  if (!value.startsWith(expectedPrefix)) {
    throw new Error("BRIDGE_PUBLIC_STREAM_URL must use a canonical lowercase scheme");
  }
  if (url.href !== value) {
    throw new Error("BRIDGE_PUBLIC_STREAM_URL must use its canonical WHATWG serialization");
  }
  // Twilio signs the configured bytes. Do not normalize them after validation.
  return value;
}

function relativeApiPath(env, name, fallback) {
  const value = env[name] ?? fallback;
  if (typeof value !== "string" || !/^\/[A-Za-z0-9_./-]{1,255}$/.test(value) || value.includes("..")) {
    throw new Error(`${name} must be a bounded same-origin absolute path`);
  }
  return value;
}

function allowedTools(env) {
  const raw = env.BRIDGE_ALLOWED_CLIENT_TOOLS ?? "capability_gateway";
  const entries = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
  const tools = [...new Set(entries)];
  if (tools.length < 1 || tools.length > 32 || tools.some((tool) => !SAFE_TOOL.test(tool))) {
    throw new Error("BRIDGE_ALLOWED_CLIENT_TOOLS must contain 1-32 canonical tool names");
  }
  if (tools.length !== entries.length) throw new Error("BRIDGE_ALLOWED_CLIENT_TOOLS cannot repeat a tool name");
  return Object.freeze(tools);
}

export function loadBridgeConfig(env = process.env) {
  const production = env.NODE_ENV === "production";
  const requestedInsecure = booleanEnv(env, "BRIDGE_ALLOW_INSECURE_LOCAL_TESTS", false);
  if (production && requestedInsecure) throw new Error("BRIDGE_ALLOW_INSECURE_LOCAL_TESTS is forbidden in production");
  const allowInsecureLocalTests = !production && requestedInsecure;
  const instanceId = env.BRIDGE_INSTANCE_ID ?? `bridge-${randomUUID()}`;
  if (!SAFE_ID.test(instanceId)) throw new Error("BRIDGE_INSTANCE_ID is malformed");

  const config = {
    port: integerEnv(env, "PORT", 8080, 1, 65_535),
    appOrigin: originUrl(required(env, "APP_ORIGIN"), { allowInsecure: allowInsecureLocalTests }),
    publicStreamUrl: streamUrl(required(env, "BRIDGE_PUBLIC_STREAM_URL"), { allowInsecure: allowInsecureLocalTests }),
    twilioAccountSid: required(env, "TWILIO_ACCOUNT_SID"),
    twilioAuthToken: required(env, "TWILIO_AUTH_TOKEN", 20),
    providerKeys: Object.freeze({
      openai: optionalCredential(env, "OPENAI_API_KEY"),
      xai: optionalCredential(env, "XAI_API_KEY"),
    }),
    instanceId,
    allowInsecureLocalTests,
    strictTwilioProtocol: !allowInsecureLocalTests,
    sessionPath: relativeApiPath(env, "BRIDGE_SESSION_PATH", "/api/telephony/bridge/session"),
    authorityPath: relativeApiPath(env, "BRIDGE_AUTHORITY_PATH", "/api/mcp"),
    eventsPath: relativeApiPath(env, "BRIDGE_EVENTS_PATH", "/api/telephony/bridge/events"),
    allowedClientTools: allowedTools(env),
    limits: Object.freeze({
      maximumConcurrentSessions: integerEnv(env, "BRIDGE_MAX_CONCURRENT_SESSIONS", 1_000, 1, 50_000),
      twilioMessageBytes: integerEnv(env, "BRIDGE_MAX_TWILIO_MESSAGE_BYTES", 64 * 1024, 1_024, 256 * 1024),
      providerMessageBytes: integerEnv(env, "BRIDGE_MAX_PROVIDER_MESSAGE_BYTES", 2 * 1024 * 1024, 16 * 1024, 2 * 1024 * 1024),
      mediaFrameBytes: integerEnv(env, "BRIDGE_MAX_MEDIA_FRAME_BYTES", 8 * 1024, 160, 64 * 1024),
      inputQueueMessages: integerEnv(env, "BRIDGE_INPUT_QUEUE_MESSAGES", 500, 10, 5_000),
      inputQueueBytes: integerEnv(env, "BRIDGE_INPUT_QUEUE_BYTES", 2 * 1024 * 1024, 64 * 1024, 16 * 1024 * 1024),
      outputQueueMessages: integerEnv(env, "BRIDGE_OUTPUT_QUEUE_MESSAGES", 1_000, 10, 10_000),
      outputQueueBytes: integerEnv(env, "BRIDGE_OUTPUT_QUEUE_BYTES", 4 * 1024 * 1024, 64 * 1024, 32 * 1024 * 1024),
      socketHighWaterBytes: integerEnv(env, "BRIDGE_SOCKET_HIGH_WATER_BYTES", 512 * 1024, 16 * 1024, 8 * 1024 * 1024),
      maximumPendingMarks: integerEnv(env, "BRIDGE_MAX_PENDING_MARKS", 2_000, 10, 10_000),
      playbackMarkBytes: integerEnv(env, "BRIDGE_PLAYBACK_MARK_BYTES", 800, 160, 8_000),
      maximumToolCalls: integerEnv(env, "BRIDGE_MAX_TOOL_CALLS", 128, 1, 1_000),
      twilioStartMs: integerEnv(env, "BRIDGE_TWILIO_START_MS", 10_000, 1_000, 60_000),
      drainIntervalMs: integerEnv(env, "BRIDGE_DRAIN_INTERVAL_MS", 20, 5, 1_000),
      providerConnectMs: integerEnv(env, "BRIDGE_PROVIDER_CONNECT_MS", 10_000, 1_000, 60_000),
      sessionAckMs: integerEnv(env, "BRIDGE_SESSION_ACK_MS", 10_000, 1_000, 60_000),
      maximumCallMs: integerEnv(env, "BRIDGE_MAX_CALL_MS", 30 * 60_000, 30_000, 4 * 60 * 60_000),
      idleTimeoutMs: integerEnv(env, "BRIDGE_IDLE_TIMEOUT_MS", 60_000, 10_000, 10 * 60_000),
      shutdownMs: integerEnv(env, "BRIDGE_SHUTDOWN_MS", 8_000, 1_000, 60_000),
    }),
  };
  if (!/^AC[0-9a-fA-F]{32}$/.test(config.twilioAccountSid)) {
    throw new Error("TWILIO_ACCOUNT_SID must be a canonical account SID");
  }
  return Object.freeze(config);
}

export const bridgeConfigInternals = Object.freeze({ isLoopback });
