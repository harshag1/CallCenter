import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  BRIDGE_REPLAY_STORE_TIMEOUT_MS,
  BRIDGE_TOKEN_AUDIENCE,
  BRIDGE_TOKEN_DEFAULT_TTL_SECONDS,
  BRIDGE_TOKEN_MAX_FUTURE_SKEW_SECONDS,
  BRIDGE_TOKEN_MAX_TTL_SECONDS,
  BRIDGE_TOKEN_PURPOSE,
  BridgeTokenReplayCache,
  computeTwilioSignature,
  mintBridgeToken,
  verifyAndConsumeBridgeToken,
  verifyTwilioSignature,
} from "../lib/auth.js";

const TOKEN_DOMAIN = "harshas-amazing-call-center/bridge-bootstrap-token/v2\n";
const SECRET = "0123456789abcdefFEDCBA9876543210";
const TWILIO_AUTH_TOKEN = "0123456789abcdef0123456789abcdef";
const STREAM_URL = "wss://bridge.example.com/stream";
const ACCOUNT_SID = `AC${"1".repeat(32)}`;
const OTHER_ACCOUNT_SID = `AC${"9".repeat(32)}`;
const CALL_SID = `CA${"2".repeat(32)}`;
const OTHER_CALL_SID = `CA${"8".repeat(32)}`;
const STREAM_SID = `MZ${"3".repeat(32)}`;
const OTHER_STREAM_SID = `MZ${"7".repeat(32)}`;
const SESSION_ID = "bridge-session_01:test";
const OTHER_SESSION_ID = "bridge-session_02:test";
const NOW = 1_800_000_000;
const JTI = "AAECAwQFBgcICQoLDA0ODw";

function tokenClaims(token) {
  const [body] = token.split(".");
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
}

function signJson(json, { secret = SECRET } = {}) {
  const body = Buffer.from(json, "utf8").toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(TOKEN_DOMAIN, "utf8")
    .update(body, "ascii")
    .digest("base64url");
  return `${body}.${signature}`;
}

function signClaims(claims, { json = JSON.stringify(claims), secret = SECRET } = {}) {
  return signJson(json, { secret });
}

function validClaims(overrides = {}) {
  return {
    aud: BRIDGE_TOKEN_AUDIENCE,
    purpose: BRIDGE_TOKEN_PURPOSE,
    iat: NOW,
    exp: NOW + BRIDGE_TOKEN_DEFAULT_TTL_SECONDS,
    jti: JTI,
    account_sid: ACCOUNT_SID,
    call_sid: CALL_SID,
    mode: "agent",
    ...overrides,
  };
}

function mint(overrides = {}) {
  return mintBridgeToken({
    accountSid: ACCOUNT_SID,
    callSid: CALL_SID,
    mode: "agent",
    secret: SECRET,
    nowSeconds: NOW,
    jti: JTI,
    ...overrides,
  });
}

function verify(token, options = {}) {
  return verifyAndConsumeBridgeToken({
    token,
    accountSid: ACCOUNT_SID,
    callSid: CALL_SID,
    streamSid: STREAM_SID,
    sessionId: SESSION_ID,
    mode: "agent",
    secret: SECRET,
    replayCache: new BridgeTokenReplayCache(),
    nowSeconds: NOW,
    ...options,
  });
}

function expectedBinding(overrides = {}) {
  return {
    audience: BRIDGE_TOKEN_AUDIENCE,
    purpose: BRIDGE_TOKEN_PURPOSE,
    account_sid: ACCOUNT_SID,
    call_sid: CALL_SID,
    stream_sid: STREAM_SID,
    session_id: SESSION_ID,
    mode: "agent",
    ...overrides,
  };
}

test("Twilio Media Streams signature matches an independent URL-only HMAC-SHA1 vector", () => {
  // Generated independently with:
  // printf URL | openssl dgst -sha1 -hmac AUTH_TOKEN -binary | openssl base64
  const expected = "7GAVq+IBhCXoqfI7HYadv4kll4g=";
  assert.equal(computeTwilioSignature({ authToken: TWILIO_AUTH_TOKEN, configuredUrl: STREAM_URL }), expected);
  assert.equal(verifyTwilioSignature({
    authToken: TWILIO_AUTH_TOKEN,
    configuredUrl: STREAM_URL,
    signatureHeader: expected,
  }), true);
});

test("Twilio verification authenticates the configured canonical URL bytes exactly", () => {
  const signatureHeader = computeTwilioSignature({ authToken: TWILIO_AUTH_TOKEN, configuredUrl: STREAM_URL });
  for (const configuredUrl of [
    `${STREAM_URL}/`,
    STREAM_URL.replace("/stream", ":8443/stream"),
    STREAM_URL.replace("/stream", "/other"),
  ]) {
    assert.notEqual(
      computeTwilioSignature({ authToken: TWILIO_AUTH_TOKEN, configuredUrl }),
      signatureHeader
    );
    assert.equal(verifyTwilioSignature({ authToken: TWILIO_AUTH_TOKEN, configuredUrl, signatureHeader }), false);
  }
});

test("Twilio verification fails closed for non-canonical URLs and malformed headers", () => {
  const signatureHeader = computeTwilioSignature({ authToken: TWILIO_AUTH_TOKEN, configuredUrl: STREAM_URL });
  for (const configuredUrl of [
    "https://bridge.example.com/stream",
    `${STREAM_URL}?token=x`,
    `${STREAM_URL}?`,
    `${STREAM_URL}#fragment`,
    "wss://bridge.example.com/stream\\evil",
    "wss://bridge.example.com/stream%zz",
    "wss://BRIDGE.example.com/stream",
    "wss://bridge.example.com:443/stream",
    "wss://bridge.example.com/a/../stream",
    "wss://éxample.com/stream",
    "wss://user:password@bridge.example.com/stream",
    "wss://bridge.example.com",
  ]) {
    assert.throws(() => computeTwilioSignature({ authToken: TWILIO_AUTH_TOKEN, configuredUrl }));
    assert.equal(verifyTwilioSignature({ authToken: TWILIO_AUTH_TOKEN, configuredUrl, signatureHeader }), false);
  }
  assert.equal(verifyTwilioSignature({
    authToken: "short",
    configuredUrl: STREAM_URL,
    signatureHeader,
  }), false);
  for (const badHeader of [undefined, "", "not-base64", `${signatureHeader}x`, [signatureHeader], 1]) {
    assert.equal(verifyTwilioSignature({
      authToken: TWILIO_AUTH_TOKEN,
      configuredUrl: STREAM_URL,
      signatureHeader: badHeader,
    }), false);
  }
  assert.equal(verifyTwilioSignature(), false);
  assert.equal(verifyTwilioSignature(null), false);
});

test("mintBridgeToken emits only the compact v2 session-exchange claims under Twilio's 500-byte limit", () => {
  const token = mint();
  const claims = tokenClaims(token);

  assert.equal(token.split(".").length, 2);
  assert.ok(Buffer.byteLength(token, "utf8") <= 500);
  assert.deepEqual(claims, validClaims());
  assert.deepEqual(Object.keys(claims), [
    "aud",
    "purpose",
    "iat",
    "exp",
    "jti",
    "account_sid",
    "call_sid",
    "mode",
  ]);
  assert.equal(claims.aud, "bridge_bootstrap");
  assert.equal(claims.purpose, "telephony_stream_exchange");
  assert.equal(claims.exp - claims.iat, BRIDGE_TOKEN_DEFAULT_TTL_SECONDS);
  assert.equal(Object.hasOwn(claims, "stream_sid"), false);
  assert.equal(Object.hasOwn(claims, "session_id"), false);
  assert.equal(Object.hasOwn(claims, "scope"), false);
  assert.equal(Object.hasOwn(claims, "scope_sha256"), false);
});

test("verification consumes once and hands the durable store the exact first-use binding", async () => {
  const token = mint();
  const calls = [];
  const consumed = new Set();
  const durableAtomicStore = {
    marker: "receiver-preserved",
    async consume(jti, expiresAt, nowSeconds, binding) {
      assert.equal(this.marker, "receiver-preserved");
      calls.push({ jti, expiresAt, nowSeconds, binding });
      if (consumed.has(jti)) return { ok: false, code: "replayed" };
      consumed.add(jti);
      return { ok: true };
    },
  };

  const first = await verify(token, { replayCache: durableAtomicStore });
  assert.equal(first.ok, true);
  assert.deepEqual(first.claims, validClaims());
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.claims), true);
  assert.deepEqual(await verify(token, { replayCache: durableAtomicStore }), { ok: false, code: "replayed" });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.jti, JTI);
    assert.equal(call.expiresAt, NOW + BRIDGE_TOKEN_DEFAULT_TTL_SECONDS);
    assert.equal(call.nowSeconds, NOW);
    assert.deepEqual(call.binding, expectedBinding());
    assert.equal(Object.isFrozen(call.binding), true);
  }
});

test("signed account, call, and mode mismatches fail before and do not burn the token", async () => {
  const token = mint();
  const calls = [];
  const replayCache = {
    consume(...args) {
      calls.push(args);
      return { ok: true };
    },
  };

  for (const mismatch of [
    { accountSid: OTHER_ACCOUNT_SID },
    { callSid: OTHER_CALL_SID },
    { mode: "observe" },
  ]) {
    assert.deepEqual(await verify(token, { replayCache, ...mismatch }), { ok: false, code: "binding_mismatch" });
    assert.equal(calls.length, 0);
  }
  assert.equal((await verify(token, { replayCache })).ok, true);
  assert.equal(calls.length, 1);
});

test("StreamSid and session substitution are bound atomically at first use and replay thereafter", async () => {
  const token = mint();
  const records = new Map();
  const durableAtomicStore = {
    consume(jti, expiresAt, nowSeconds, binding) {
      if (records.has(jti)) return { ok: false, code: "replayed" };
      records.set(jti, { expiresAt, nowSeconds, binding });
      return { ok: true };
    },
  };

  assert.equal((await verify(token, { replayCache: durableAtomicStore })).ok, true);
  assert.deepEqual(await verify(token, {
    replayCache: durableAtomicStore,
    streamSid: OTHER_STREAM_SID,
  }), { ok: false, code: "replayed" });
  assert.deepEqual(await verify(token, {
    replayCache: durableAtomicStore,
    sessionId: OTHER_SESSION_ID,
  }), { ok: false, code: "replayed" });
  assert.deepEqual(records.get(JTI).binding, expectedBinding());
});

test("invalid or missing first-use StreamSid and session bindings fail before consume", async () => {
  const token = mint();
  let calls = 0;
  const replayCache = { consume: () => { calls += 1; return { ok: true }; } };
  for (const invalid of [
    { streamSid: undefined },
    { streamSid: `CA${"3".repeat(32)}` },
    { streamSid: `MZ${"z".repeat(32)}` },
    { sessionId: undefined },
    { sessionId: "" },
    { sessionId: "space is forbidden" },
    { sessionId: "x".repeat(129) },
  ]) {
    assert.deepEqual(await verify(token, { replayCache, ...invalid }), {
      ok: false,
      code: "invalid_verifier_configuration",
    });
  }
  assert.equal(calls, 0);
});

test("verification authenticates the body before strict canonical claim parsing", async () => {
  const token = mint();
  const [body, signature] = token.split(".");
  const changed = `${body.slice(0, -1)}${body.endsWith("A") ? "B" : "A"}.${signature}`;

  assert.deepEqual(await verify(changed), { ok: false, code: "invalid_signature" });
  assert.deepEqual(await verify(`${token}.extra`), { ok: false, code: "malformed_token" });
  assert.deepEqual(await verify(`${body}.not-base64`), { ok: false, code: "malformed_token" });
  assert.deepEqual(await verify("x".repeat(501)), { ok: false, code: "malformed_token" });

  assert.deepEqual(await verify(signClaims({ ...validClaims(), extra: true })), {
    ok: false,
    code: "invalid_claims",
  });
  const reordered = {
    purpose: BRIDGE_TOKEN_PURPOSE,
    aud: BRIDGE_TOKEN_AUDIENCE,
    iat: NOW,
    exp: NOW + 120,
    jti: JTI,
    account_sid: ACCOUNT_SID,
    call_sid: CALL_SID,
    mode: "agent",
  };
  assert.deepEqual(await verify(signClaims(reordered)), { ok: false, code: "invalid_claims" });
  assert.deepEqual(await verify(signClaims(validClaims({ aud: "telephony_events" }))), {
    ok: false,
    code: "invalid_claims",
  });
  assert.deepEqual(await verify(signClaims(validClaims({ purpose: "event_journal" }))), {
    ok: false,
    code: "invalid_claims",
  });
  const duplicatePurpose = JSON.stringify(validClaims()).replace(
    `"purpose":"${BRIDGE_TOKEN_PURPOSE}"`,
    `"purpose":"${BRIDGE_TOKEN_PURPOSE}","purpose":"event_journal"`
  );
  assert.deepEqual(await verify(signJson(duplicatePurpose)), { ok: false, code: "invalid_claims" });
});

test("bridge-token lifetime is capped, expires without grace, and bounds future skew", async () => {
  assert.equal(
    (await verify(signClaims(validClaims({ exp: NOW + BRIDGE_TOKEN_MAX_TTL_SECONDS })))).ok,
    true
  );
  assert.deepEqual(
    await verify(signClaims(validClaims({ exp: NOW + BRIDGE_TOKEN_MAX_TTL_SECONDS + 1 }))),
    { ok: false, code: "invalid_lifetime" }
  );
  assert.deepEqual(
    await verify(signClaims(validClaims({ iat: NOW - 120, exp: NOW }))),
    { ok: false, code: "expired" }
  );
  assert.deepEqual(
    await verify(signClaims(validClaims({ exp: NOW }))),
    { ok: false, code: "invalid_lifetime" }
  );
  assert.deepEqual(
    await verify(signClaims(validClaims({ iat: NOW + 11, exp: NOW + 131 })), { futureSkewSeconds: 10 }),
    { ok: false, code: "not_yet_valid" }
  );
  assert.equal(
    (await verify(signClaims(validClaims({ iat: NOW + 10, exp: NOW + 130 })), {
      futureSkewSeconds: BRIDGE_TOKEN_MAX_FUTURE_SKEW_SECONDS,
    })).ok,
    true
  );
  assert.equal(
    (await verify(signClaims(validClaims({ iat: NOW + 5, exp: NOW + 125 })))).ok,
    true
  );
  assert.deepEqual(
    await verify(signClaims(validClaims({ iat: NOW + 6, exp: NOW + 126 }))),
    { ok: false, code: "not_yet_valid" }
  );
  assert.deepEqual(
    await verify(signClaims(validClaims()), { futureSkewSeconds: 11 }),
    { ok: false, code: "invalid_verifier_configuration" }
  );
});

test("minting rejects invalid lifetimes, weak keys, identifiers, modes, and JTIs", () => {
  const base = {
    accountSid: ACCOUNT_SID,
    callSid: CALL_SID,
    mode: "agent",
    secret: SECRET,
    nowSeconds: NOW,
    jti: JTI,
  };
  assert.throws(() => mintBridgeToken({ ...base, ttlSeconds: 0 }), RangeError);
  assert.throws(() => mintBridgeToken({ ...base, ttlSeconds: BRIDGE_TOKEN_MAX_TTL_SECONDS + 1 }), RangeError);
  assert.throws(() => mintBridgeToken({ ...base, nowSeconds: Number.MAX_SAFE_INTEGER }));
  assert.throws(() => mintBridgeToken({ ...base, secret: "x".repeat(32) }));
  assert.throws(() => mintBridgeToken({ ...base, secret: "short-secret" }));
  assert.throws(() => mintBridgeToken({ ...base, accountSid: `AC${"x".repeat(32)}` }));
  assert.throws(() => mintBridgeToken({ ...base, callSid: `CA${"2".repeat(31)}` }));
  assert.throws(() => mintBridgeToken({ ...base, mode: "admin" }));
  assert.throws(() => mintBridgeToken({ ...base, jti: "short" }));
});

test("verification requires an atomic replay adapter and maps only explicit replay/capacity results", async () => {
  const token = mint();
  assert.deepEqual(await verifyAndConsumeBridgeToken({
    token,
    accountSid: ACCOUNT_SID,
    callSid: CALL_SID,
    streamSid: STREAM_SID,
    sessionId: SESSION_ID,
    mode: "agent",
    secret: SECRET,
    nowSeconds: NOW,
  }), { ok: false, code: "replay_cache_required" });
  assert.deepEqual(await verifyAndConsumeBridgeToken(), { ok: false, code: "invalid_verifier_configuration" });
  assert.deepEqual(await verifyAndConsumeBridgeToken(null), { ok: false, code: "invalid_verifier_configuration" });
  assert.deepEqual(await verifyAndConsumeBridgeToken([]), { ok: false, code: "invalid_verifier_configuration" });
  assert.deepEqual(await verify(token, { replayCache: {} }), { ok: false, code: "replay_cache_required" });
  assert.deepEqual(await verify(token, { replayCache: { consume: () => { throw new Error("down"); } } }), {
    ok: false,
    code: "replay_cache_error",
  });
  assert.deepEqual(await verify(token, { replayCache: { consume: () => ({ ok: false, code: "capacity" }) } }), {
    ok: false,
    code: "replay_cache_full",
  });
  assert.deepEqual(await verify(token, { replayCache: { consume: () => ({ ok: false, code: "clock_rollback" }) } }), {
    ok: false,
    code: "replay_cache_error",
  });
  assert.deepEqual(await verify(token, { secret: "abcdef0123456789abcdef0123456789" }), {
    ok: false,
    code: "invalid_signature",
  });
});

test("bounded development cache prunes expiry, never evicts live tombstones, and rejects clock rollback", () => {
  const cache = new BridgeTokenReplayCache({ maxEntries: 2 });
  const secondJti = "EBESExQVFhcYGRobHB0eHw";
  const thirdJti = "ICEiIyQlJicoKSorLC0uLw";
  assert.deepEqual(cache.consume(JTI, 110, 100, expectedBinding()), { ok: true });
  assert.deepEqual(cache.consume(JTI, 110, 100, expectedBinding()), { ok: false, code: "replayed" });
  assert.deepEqual(cache.consume(secondJti, 110, 100, expectedBinding()), { ok: true });
  assert.deepEqual(cache.consume(thirdJti, 120, 100, expectedBinding()), { ok: false, code: "capacity" });
  assert.equal(cache.size, 2);
  assert.equal(cache.maxEntries, 2);
  assert.equal(cache.prune, undefined);
  assert.throws(() => { cache.maxEntries = 10; }, TypeError);
  assert.deepEqual(cache.consume(thirdJti, 120, 110, expectedBinding()), { ok: true });
  assert.equal(cache.size, 1);
  assert.deepEqual(cache.consume(secondJti, 421, 110, expectedBinding()), { ok: false, code: "invalid_expiry" });
  assert.throws(() => cache.consume("bad", 120, 110, expectedBinding()));
  assert.throws(() => new BridgeTokenReplayCache({ maxEntries: 0 }), RangeError);
  assert.throws(() => new BridgeTokenReplayCache({ maxEntries: 100_001 }), RangeError);

  const rollbackCache = new BridgeTokenReplayCache();
  assert.deepEqual(rollbackCache.consume(JTI, 110, 100, expectedBinding()), { ok: true });
  assert.deepEqual(rollbackCache.consume(secondJti, 210, 200, expectedBinding()), { ok: true });
  // The first tombstone was pruned at t=200. Moving the verifier clock back to
  // t=105 must fail closed instead of accepting that old token again.
  assert.deepEqual(rollbackCache.consume(JTI, 110, 105, expectedBinding()), {
    ok: false,
    code: "clock_rollback",
  });
});

test("concurrent durable consumes produce one creator and one replay with identical metadata", async () => {
  const token = mint();
  const consumed = new Set();
  const calls = [];
  const durableAtomicStore = {
    async consume(jti, expiresAt, nowSeconds, binding) {
      calls.push({ jti, expiresAt, nowSeconds, binding });
      await Promise.resolve();
      if (consumed.has(jti)) return { ok: false, code: "replayed" };
      consumed.add(jti); // models one conditional insert / SET-NX winner
      return { ok: true };
    },
  };
  const outcomes = await Promise.all([
    verify(token, { replayCache: durableAtomicStore }),
    verify(token, { replayCache: durableAtomicStore }),
  ]);
  assert.equal(outcomes.filter((result) => result.ok).length, 1);
  assert.equal(outcomes.filter((result) => result.code === "replayed").length, 1);
  assert.deepEqual(calls.map(({ jti, expiresAt, nowSeconds, binding }) => ({
    jti,
    expiresAt,
    nowSeconds,
    binding,
  })), [
    {
      jti: JTI,
      expiresAt: NOW + 120,
      nowSeconds: NOW,
      binding: expectedBinding(),
    },
    {
      jti: JTI,
      expiresAt: NOW + 120,
      nowSeconds: NOW,
      binding: expectedBinding(),
    },
  ]);
});

test("async replay adapter exceptions, timeouts, proxies, and malformed results fail closed", async () => {
  const token = mint();
  const throwingMethodGetter = Object.defineProperty({}, "consume", {
    get() { throw new Error("adapter unavailable"); },
  });
  const throwingResultGetter = {
    consume: async () => Object.defineProperty({}, "ok", {
      enumerable: true,
      get() { throw new Error("malformed result"); },
    }),
  };
  for (const replayCache of [
    throwingMethodGetter,
    throwingResultGetter,
    { consume: async () => { throw new Error("store down"); } },
    { consume: async () => true },
    { consume: async () => ({ ok: true, ignored: true }) },
    { consume: async () => ({ ok: false }) },
    { consume: async () => ({ ok: false, code: 1 }) },
    { consume: async () => ({ ok: false, code: "replayed", extra: true }) },
  ]) {
    assert.deepEqual(await verify(token, { replayCache }), { ok: false, code: "replay_cache_error" });
  }
  assert.equal(BRIDGE_REPLAY_STORE_TIMEOUT_MS, 2_000);
  assert.deepEqual(await verify(token, {
    replayCache: { consume: () => new Promise(() => {}) },
    replayStoreTimeoutMs: 5,
  }), { ok: false, code: "replay_cache_error" });
  assert.deepEqual(await verify(token, { replayStoreTimeoutMs: 0 }), {
    ok: false,
    code: "invalid_verifier_configuration",
  });

  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.deepEqual(await verifyAndConsumeBridgeToken(revoked.proxy), {
    ok: false,
    code: "invalid_verifier_configuration",
  });
});
