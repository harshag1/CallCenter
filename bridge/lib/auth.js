import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  assertBoundedString,
  assertExactObject,
  parseCappedJson,
} from "./safe-json.js";

const TOKEN_AUDIENCE = "bridge_bootstrap";
const TOKEN_PURPOSE = "telephony_stream_exchange";
const TOKEN_SIGNATURE_DOMAIN = "harshas-amazing-call-center/bridge-bootstrap-token/v2\n";
const ACCOUNT_SID_PATTERN = /^AC[0-9a-fA-F]{32}$/;
const CALL_SID_PATTERN = /^CA[0-9a-fA-F]{32}$/;
const STREAM_SID_PATTERN = /^MZ[0-9a-fA-F]{32}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const JTI_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const TWILIO_SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{27}=$/;
const BASE64URL_BODY_PATTERN = /^[A-Za-z0-9_-]{1,1536}$/;
const BASE64URL_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CONTROL_FREE_PATTERN = /^[^\u0000-\u001f\u007f]+$/;
const TOKEN_CLAIM_KEYS = Object.freeze([
  "aud",
  "purpose",
  "iat",
  "exp",
  "jti",
  "account_sid",
  "call_sid",
  "mode",
]);
const REPLAY_STORE_TIMEOUT = Symbol("replay-store-timeout");

export const BRIDGE_TOKEN_AUDIENCE = TOKEN_AUDIENCE;
export const BRIDGE_TOKEN_PURPOSE = TOKEN_PURPOSE;
export const BRIDGE_TOKEN_DEFAULT_TTL_SECONDS = 120;
export const BRIDGE_TOKEN_MAX_TTL_SECONDS = 300;
export const BRIDGE_TOKEN_MAX_FUTURE_SKEW_SECONDS = 10;
export const BRIDGE_REPLAY_STORE_TIMEOUT_MS = 2_000;
export const BRIDGE_MODES = Object.freeze(["agent", "observe"]);

const MODE_SET = new Set(BRIDGE_MODES);

function fail(code) {
  return Object.freeze({ ok: false, code });
}

function nowInSeconds(value = Math.floor(Date.now() / 1_000)) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("nowSeconds must be a non-negative safe integer");
  return value;
}

function assertSeconds(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} is outside its allowed range`);
  }
  return value;
}

function secretBytes(secret) {
  let bytes;
  if (typeof secret === "string") {
    bytes = Buffer.from(secret, "utf8");
  } else if (Buffer.isBuffer(secret) || ArrayBuffer.isView(secret)) {
    bytes = Buffer.from(secret.buffer, secret.byteOffset, secret.byteLength);
  } else if (secret instanceof ArrayBuffer) {
    bytes = Buffer.from(secret);
  } else {
    throw new TypeError("bridge token secret must be a string or byte sequence");
  }
  if (bytes.length < 32 || bytes.length > 512 || new Set(bytes).size < 8) {
    throw new Error("bridge token secret must contain at least 32 non-placeholder bytes");
  }
  return Buffer.from(bytes);
}

function twilioAuthToken(authToken) {
  assertBoundedString(authToken, {
    minBytes: 16,
    maxBytes: 256,
    pattern: CONTROL_FREE_PATTERN,
  });
  return authToken;
}

function exactStreamUrl(configuredUrl) {
  assertBoundedString(configuredUrl, {
    minBytes: 12,
    maxBytes: 2_048,
    pattern: /^wss:\/\/[\x21-\x7e]+$/,
  });
  // TwiML <Stream> URLs do not support query strings. Reject even an empty `?`
  // rather than allowing URL parsing to erase a byte that Twilio signed.
  if (configuredUrl.includes("?") || configuredUrl.includes("#")) {
    throw new Error("configured stream URL cannot contain a query or fragment");
  }
  if (configuredUrl.includes("\\") || /%(?![0-9a-fA-F]{2})/.test(configuredUrl)) {
    throw new Error("configured stream URL is not canonically encoded");
  }
  let parsed;
  try {
    parsed = new URL(configuredUrl);
  } catch {
    throw new Error("configured stream URL is invalid");
  }
  if (
    parsed.protocol !== "wss:" ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("configured stream URL must be an absolute credential-free wss URL");
  }
  if (parsed.href !== configuredUrl) {
    throw new Error("configured stream URL must use its canonical WHATWG serialization");
  }
  // Return the configured bytes, not URL.href. Signature validation must not
  // normalize host case, escaping, a port, or a trailing slash.
  return configuredUrl;
}

/** Computes Twilio's URL-only HMAC-SHA1 signature for a Media Streams upgrade. */
export function computeTwilioSignature({ authToken, configuredUrl }) {
  return createHmac("sha1", twilioAuthToken(authToken))
    .update(exactStreamUrl(configuredUrl), "utf8")
    .digest("base64");
}

/**
 * Validates X-Twilio-Signature against the configured public <Stream> URL.
 * The API deliberately accepts no request/proxy URL from which authority could
 * be reconstructed incorrectly.
 */
export function verifyTwilioSignature(input) {
  try {
    const { authToken, configuredUrl, signatureHeader } = input ?? {};
    if (typeof signatureHeader !== "string" || !TWILIO_SIGNATURE_PATTERN.test(signatureHeader)) return false;
    const actual = Buffer.from(signatureHeader, "base64");
    if (actual.length !== 20 || actual.toString("base64") !== signatureHeader) return false;
    const expected = Buffer.from(computeTwilioSignature({ authToken, configuredUrl }), "base64");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function accountSid(value) {
  assertBoundedString(value, { minBytes: 34, maxBytes: 34, pattern: ACCOUNT_SID_PATTERN });
  return value;
}

function streamSid(value) {
  assertBoundedString(value, { minBytes: 34, maxBytes: 34, pattern: STREAM_SID_PATTERN });
  return value;
}

function sessionId(value) {
  assertBoundedString(value, { minBytes: 1, maxBytes: 128, pattern: SESSION_ID_PATTERN });
  return value;
}

function callSid(value) {
  assertBoundedString(value, { minBytes: 34, maxBytes: 34, pattern: CALL_SID_PATTERN });
  return value;
}

function bridgeMode(value) {
  if (typeof value !== "string" || !MODE_SET.has(value)) throw new Error("invalid bridge mode");
  return value;
}

function canonicalJti(value) {
  assertBoundedString(value, { minBytes: 22, maxBytes: 22, pattern: JTI_PATTERN });
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 16 || decoded.toString("base64url") !== value) throw new Error("invalid bridge token jti");
  return value;
}

function newJti() {
  return randomBytes(16).toString("base64url");
}

function canonicalClaims(claims) {
  return {
    aud: claims.aud,
    purpose: claims.purpose,
    iat: claims.iat,
    exp: claims.exp,
    jti: claims.jti,
    account_sid: claims.account_sid,
    call_sid: claims.call_sid,
    mode: claims.mode,
  };
}

function tokenMac(secret, body) {
  return createHmac("sha256", secretBytes(secret))
    .update(TOKEN_SIGNATURE_DOMAIN, "utf8")
    .update(body, "ascii")
    .digest();
}

/** Mints the compact, short-lived capability used only for session exchange. */
export function mintBridgeToken({
  accountSid: expectedAccountSid,
  callSid: expectedCallSid,
  mode,
  secret,
  nowSeconds = Math.floor(Date.now() / 1_000),
  ttlSeconds = BRIDGE_TOKEN_DEFAULT_TTL_SECONDS,
  jti = newJti(),
}) {
  const issuedAt = nowInSeconds(nowSeconds);
  assertSeconds(ttlSeconds, "ttlSeconds", { min: 1, max: BRIDGE_TOKEN_MAX_TTL_SECONDS });
  const expiresAt = assertSeconds(issuedAt + ttlSeconds, "exp");
  const claims = Object.freeze(canonicalClaims({
    aud: TOKEN_AUDIENCE,
    purpose: TOKEN_PURPOSE,
    iat: issuedAt,
    exp: expiresAt,
    jti: canonicalJti(jti),
    account_sid: accountSid(expectedAccountSid),
    call_sid: callSid(expectedCallSid),
    mode: bridgeMode(mode),
  }));
  const body = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = tokenMac(secret, body).toString("base64url");
  const token = `${body}.${signature}`;
  if (Buffer.byteLength(token, "utf8") > 500) throw new Error("bridge bootstrap token exceeds Twilio Parameter value limit");
  return token;
}

function parseClaims(body) {
  if (!BASE64URL_BODY_PATTERN.test(body)) throw new Error("invalid token body encoding");
  const bytes = Buffer.from(body, "base64url");
  if (bytes.toString("base64url") !== body) throw new Error("non-canonical token body encoding");
  const claims = assertExactObject(parseCappedJson(bytes, {
    maxBytes: 1_024,
    maxDepth: 1,
    maxNodes: 9,
    maxObjectKeys: 8,
    maxArrayLength: 1,
    maxStringBytes: 128,
    maxKeyBytes: 32,
    maxNumberChars: 16,
  }), { requiredKeys: TOKEN_CLAIM_KEYS });

  if (claims.aud !== TOKEN_AUDIENCE) throw new Error("invalid token audience");
  if (claims.purpose !== TOKEN_PURPOSE) throw new Error("invalid token purpose");
  assertSeconds(claims.iat, "iat");
  assertSeconds(claims.exp, "exp");
  canonicalJti(claims.jti);
  accountSid(claims.account_sid);
  callSid(claims.call_sid);
  bridgeMode(claims.mode);

  const canonical = JSON.stringify(canonicalClaims(claims));
  if (Buffer.from(canonical, "utf8").toString("base64url") !== body) {
    throw new Error("non-canonical token claims");
  }
  return Object.freeze(canonicalClaims(claims));
}

function earlierExpiry(left, right) {
  return left.expiresAt < right.expiresAt ||
    (left.expiresAt === right.expiresAt && left.jti < right.jti);
}

function pushExpiry(heap, entry) {
  heap.push(entry);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (!earlierExpiry(heap[index], heap[parent])) break;
    [heap[index], heap[parent]] = [heap[parent], heap[index]];
    index = parent;
  }
}

function popExpiry(heap) {
  const head = heap[0];
  const tail = heap.pop();
  if (heap.length && tail) {
    heap[0] = tail;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let earliest = index;
      if (left < heap.length && earlierExpiry(heap[left], heap[earliest])) earliest = left;
      if (right < heap.length && earlierExpiry(heap[right], heap[earliest])) earliest = right;
      if (earliest === index) break;
      [heap[index], heap[earliest]] = [heap[earliest], heap[index]];
      index = earliest;
    }
  }
  return head;
}

/**
 * Bounded single-process replay store for tests and single-process development.
 * Production exchanges must inject a shared, durable adapter whose consume
 * operation and binding write are atomic (for example a conditional database
 * insert). Live tombstones are deliberately never evicted.
 */
export class InMemoryBridgeTokenReplayCache {
  #entries = new Map();
  #expirations = [];
  #maxEntries;
  #timeHighWaterMark = 0;

  constructor({ maxEntries = 10_000 } = {}) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 100_000) {
      throw new RangeError("maxEntries must be an integer from 1 through 100000");
    }
    this.#maxEntries = maxEntries;
  }

  get maxEntries() {
    return this.#maxEntries;
  }

  get size() {
    return this.#entries.size;
  }

  #prune(now) {
    let removed = 0;
    while (this.#expirations.length && this.#expirations[0].expiresAt <= now) {
      const expired = popExpiry(this.#expirations);
      if (expired && this.#entries.get(expired.jti) === expired.expiresAt) {
        this.#entries.delete(expired.jti);
        removed += 1;
      }
    }
    return removed;
  }

  /** Atomically consumes a JTI within this process; live entries are never evicted. */
  consume(jti, expiresAt, nowSeconds = Math.floor(Date.now() / 1_000)) {
    const now = nowInSeconds(nowSeconds);
    canonicalJti(jti);
    assertSeconds(expiresAt, "expiresAt", { min: 1 });
    if (now < this.#timeHighWaterMark) return Object.freeze({ ok: false, code: "clock_rollback" });
    this.#timeHighWaterMark = now;
    this.#prune(now);
    if (expiresAt <= now) return Object.freeze({ ok: false, code: "expired" });
    if (expiresAt - now > BRIDGE_TOKEN_MAX_TTL_SECONDS + BRIDGE_TOKEN_MAX_FUTURE_SKEW_SECONDS) {
      return Object.freeze({ ok: false, code: "invalid_expiry" });
    }
    if (this.#entries.has(jti)) return Object.freeze({ ok: false, code: "replayed" });
    // Evicting an unexpired token would make that token replayable. Saturation is
    // therefore an authentication failure until an entry expires.
    if (this.#entries.size >= this.#maxEntries) return Object.freeze({ ok: false, code: "capacity" });
    this.#entries.set(jti, expiresAt);
    pushExpiry(this.#expirations, { jti, expiresAt });
    return Object.freeze({ ok: true });
  }
}

export {
  InMemoryBridgeTokenReplayCache as BridgeTokenReplayCache,
  InMemoryBridgeTokenReplayCache as SingleUseReplayCache,
};

async function boundedReplayConsume(method, receiver, args, timeoutMs) {
  let timer;
  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(REPLAY_STORE_TIMEOUT), timeoutMs);
    });
    const result = await Promise.race([
      Promise.resolve().then(() => Reflect.apply(method, receiver, args)),
      timeout,
    ]);
    if (result === REPLAY_STORE_TIMEOUT) throw new Error("replay store timed out");
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Verifies every binding and consumes the token's JTI. A replay cache is
 * mandatory: omitting or breaking it fails closed. `replayCache.consume(jti,
 * expiresAt, nowSeconds, binding)` may be synchronous or return a Promise, but
 * it is a security boundary: it must atomically create a deployment-wide JTI
 * tombstone together with the supplied account/call/stream/session/mode binding
 * and retain it through `expiresAt`. It returns exactly `{ ok: true }` only for
 * the creator and `{ ok: false, code: "replayed" }` for later consumers. Store
 * calls are bounded to two seconds by default and fail closed on timeout.
 */
export async function verifyAndConsumeBridgeToken(input) {
  let isArray;
  try {
    isArray = Array.isArray(input);
  } catch {
    return fail("invalid_verifier_configuration");
  }
  if (typeof input !== "object" || input === null || isArray) {
    return fail("invalid_verifier_configuration");
  }
  let token;
  let expectedAccountSid;
  let expectedCallSid;
  let expectedStreamSid;
  let expectedSessionId;
  let mode;
  let secret;
  let replayCache;
  let nowSeconds;
  let futureSkewSeconds;
  let replayStoreTimeoutMs;
  try {
    ({
      token,
      accountSid: expectedAccountSid,
      callSid: expectedCallSid,
      streamSid: expectedStreamSid,
      sessionId: expectedSessionId,
      mode,
      secret,
      replayCache,
      nowSeconds = Math.floor(Date.now() / 1_000),
      futureSkewSeconds = 5,
      replayStoreTimeoutMs = BRIDGE_REPLAY_STORE_TIMEOUT_MS,
    } = input);
  } catch {
    return fail("invalid_verifier_configuration");
  }
  if (!replayCache) return fail("replay_cache_required");
  let consumeReplay;
  try {
    consumeReplay = replayCache.consume;
  } catch {
    return fail("replay_cache_error");
  }
  if (typeof consumeReplay !== "function") return fail("replay_cache_required");

  let now;
  let wantedAccountSid;
  let wantedCallSid;
  let wantedStreamSid;
  let wantedSessionId;
  let wantedMode;
  let key;
  try {
    now = nowInSeconds(nowSeconds);
    assertSeconds(futureSkewSeconds, "futureSkewSeconds", {
      min: 0,
      max: BRIDGE_TOKEN_MAX_FUTURE_SKEW_SECONDS,
    });
    assertSeconds(replayStoreTimeoutMs, "replayStoreTimeoutMs", { min: 1, max: 10_000 });
    wantedAccountSid = accountSid(expectedAccountSid);
    wantedCallSid = callSid(expectedCallSid);
    wantedStreamSid = streamSid(expectedStreamSid);
    wantedSessionId = sessionId(expectedSessionId);
    wantedMode = bridgeMode(mode);
    key = secretBytes(secret);
  } catch {
    return fail("invalid_verifier_configuration");
  }

  if (typeof token !== "string" || Buffer.byteLength(token, "utf8") > 500) return fail("malformed_token");
  const parts = token.split(".");
  if (parts.length !== 2) return fail("malformed_token");
  const [body, encodedSignature] = parts;
  if (!BASE64URL_BODY_PATTERN.test(body) || !BASE64URL_SIGNATURE_PATTERN.test(encodedSignature)) {
    return fail("malformed_token");
  }

  let actualSignature;
  try {
    actualSignature = Buffer.from(encodedSignature, "base64url");
  } catch {
    return fail("malformed_token");
  }
  if (actualSignature.length !== 32 || actualSignature.toString("base64url") !== encodedSignature) {
    return fail("malformed_token");
  }
  const expectedSignature = createHmac("sha256", key)
    .update(TOKEN_SIGNATURE_DOMAIN, "utf8")
    .update(body, "ascii")
    .digest();
  if (!timingSafeEqual(actualSignature, expectedSignature)) return fail("invalid_signature");

  let claims;
  try {
    claims = parseClaims(body);
  } catch {
    return fail("invalid_claims");
  }
  if (claims.exp <= claims.iat || claims.exp - claims.iat > BRIDGE_TOKEN_MAX_TTL_SECONDS) {
    return fail("invalid_lifetime");
  }
  if (claims.iat > now + futureSkewSeconds) return fail("not_yet_valid");
  if (claims.exp <= now) return fail("expired");
  if (
    claims.account_sid !== wantedAccountSid ||
    claims.call_sid !== wantedCallSid ||
    claims.mode !== wantedMode
  ) {
    return fail("binding_mismatch");
  }

  let consumedOk;
  let consumedCode;
  try {
    const consumed = await boundedReplayConsume(
      consumeReplay,
      replayCache,
      [claims.jti, claims.exp, now, Object.freeze({
        audience: TOKEN_AUDIENCE,
        purpose: TOKEN_PURPOSE,
        account_sid: wantedAccountSid,
        call_sid: wantedCallSid,
        stream_sid: wantedStreamSid,
        session_id: wantedSessionId,
        mode: wantedMode,
      })],
      replayStoreTimeoutMs
    );
    if (
      typeof consumed !== "object" ||
      consumed === null ||
      Array.isArray(consumed) ||
      (Object.getPrototypeOf(consumed) !== Object.prototype && Object.getPrototypeOf(consumed) !== null)
    ) {
      return fail("replay_cache_error");
    }
    const keys = Reflect.ownKeys(consumed);
    consumedOk = consumed.ok;
    consumedCode = consumed.code;
    if (consumedOk === true) {
      if (keys.length !== 1 || keys[0] !== "ok") return fail("replay_cache_error");
    } else if (
      consumedOk !== false ||
      keys.length !== 2 ||
      !Object.hasOwn(consumed, "ok") ||
      !Object.hasOwn(consumed, "code") ||
      typeof consumedCode !== "string"
    ) {
      return fail("replay_cache_error");
    }
  } catch {
    return fail("replay_cache_error");
  }
  if (consumedOk !== true) {
    if (consumedCode === "replayed") return fail("replayed");
    if (consumedCode === "capacity") return fail("replay_cache_full");
    return fail("replay_cache_error");
  }
  return Object.freeze({ ok: true, claims });
}
