import assert from "node:assert/strict";
import test from "node:test";

import {
  HARD_JSON_LIMITS,
  JsonResourceError,
  assertBoundedString,
  assertExactObject,
  parseCappedJson,
  parseJsonObjectResource,
} from "../lib/safe-json.js";

function rejectsWithCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof JsonResourceError);
    assert.equal(error.message, "invalid JSON resource");
    assert.equal(error.code, code);
    return true;
  });
}

test("parseCappedJson accepts strict JSON from text and ws-style binary chunks", () => {
  assert.deepEqual(parseCappedJson('{"event":"start","values":[true,false,null,-12.5e2]}'), {
    event: "start",
    values: [true, false, null, -1_250],
  });
  assert.deepEqual(
    parseCappedJson([Buffer.from('{"event":'), Buffer.from('"media"}')]),
    { event: "media" }
  );
  assert.equal(parseCappedJson(new TextEncoder().encode('"voice"')), "voice");
});

test("parseCappedJson rejects malformed, trailing, duplicate, and dangerous keys", () => {
  rejectsWithCode(() => parseCappedJson('{"event":}'), "invalid_json");
  rejectsWithCode(() => parseCappedJson('{"event":"start"} null'), "invalid_json");
  rejectsWithCode(() => parseCappedJson('{"event":1,"ev\\u0065nt":2}'), "duplicate_key");
  for (const key of ["__proto__", "constructor", "prototype"]) {
    rejectsWithCode(() => parseCappedJson(`{"${key}":{}}`), "forbidden_key");
  }
});

test("parseCappedJson requires canonical well-formed UTF-8 and Unicode", () => {
  rejectsWithCode(() => parseCappedJson(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d])), "invalid_encoding");
  rejectsWithCode(() => parseCappedJson(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])), "invalid_encoding");
  rejectsWithCode(() => parseCappedJson('"\\ud800"'), "invalid_unicode");
  rejectsWithCode(() => parseCappedJson('"\\udc00"'), "invalid_unicode");
  assert.equal(parseCappedJson('"\\ud83d\\ude80"'), "🚀");
});

test("parseCappedJson caps input before concatenating or decoding", () => {
  rejectsWithCode(() => parseCappedJson([Buffer.from("123"), Buffer.from("45")], { maxBytes: 4 }), "max_bytes");
  rejectsWithCode(() => parseCappedJson('"🚀"', { maxBytes: 5 }), "max_bytes");
  rejectsWithCode(() => parseCappedJson([]), "invalid_input");
  rejectsWithCode(
    () => parseCappedJson(Array.from({ length: 65 }, () => Buffer.alloc(0))),
    "max_chunks"
  );
  rejectsWithCode(() => parseCappedJson({ toString: () => "{}" }), "invalid_input");
});

test("parseCappedJson enforces graph, container, and scalar resource limits", () => {
  rejectsWithCode(() => parseCappedJson('{"a":{"b":{}}}', { maxDepth: 2 }), "max_depth");
  rejectsWithCode(() => parseCappedJson("[1,2]", { maxNodes: 2 }), "max_nodes");
  rejectsWithCode(() => parseCappedJson('{"a":1,"b":2}', { maxObjectKeys: 1 }), "max_object_keys");
  rejectsWithCode(() => parseCappedJson("[1,2]", { maxArrayLength: 1 }), "max_array_length");
  rejectsWithCode(() => parseCappedJson('{"long":1}', { maxKeyBytes: 3 }), "max_key_bytes");
  rejectsWithCode(() => parseCappedJson('"🚀"', { maxStringBytes: 3 }), "max_string_bytes");
  rejectsWithCode(() => parseCappedJson("1234", { maxNumberChars: 3 }), "max_number_chars");
  rejectsWithCode(() => parseCappedJson("1e400"), "invalid_number");
});

test("JSON limit configuration can only tighten or safely raise bounded ceilings", () => {
  assert.equal(parseCappedJson("[]", { maxDepth: HARD_JSON_LIMITS.maxDepth }).length, 0);
  assert.throws(() => parseCappedJson("{}", { maxDepth: HARD_JSON_LIMITS.maxDepth + 1 }), RangeError);
  assert.throws(() => parseCappedJson("{}", { maxDepth: 0 }), RangeError);
  assert.throws(() => parseCappedJson("{}", { unlimited: true }), TypeError);
  assert.throws(() => parseCappedJson("{}", { toString: 1 }), TypeError);
  assert.throws(() => parseCappedJson("{}", { [Symbol("limit")]: 1 }), TypeError);
  assert.throws(() => parseCappedJson("{}", []), TypeError);
});

test("exact object validation rejects missing, extra, array, and class resources", () => {
  assert.deepEqual(
    parseJsonObjectResource('{"event":"start","sequence":1}', {
      requiredKeys: ["event"],
      optionalKeys: ["sequence"],
    }),
    { event: "start", sequence: 1 }
  );
  rejectsWithCode(
    () => parseJsonObjectResource('{"sequence":1}', { requiredKeys: ["event"], optionalKeys: ["sequence"] }),
    "missing_key"
  );
  rejectsWithCode(
    () => parseJsonObjectResource('{"event":"start","extra":true}', { requiredKeys: ["event"] }),
    "unexpected_key"
  );
  rejectsWithCode(() => assertExactObject([]), "expected_object");
  rejectsWithCode(() => assertExactObject(new Date()), "expected_object");
  const hidden = {};
  Object.defineProperty(hidden, "hidden", { value: true });
  rejectsWithCode(() => assertExactObject(hidden), "unexpected_key");
  rejectsWithCode(() => assertExactObject({ [Symbol("hidden")]: true }), "unexpected_key");
  assert.throws(
    () => assertExactObject({}, { requiredKeys: ["event"], optionalKeys: ["event"] }),
    TypeError
  );
});

test("bounded string validation is byte-precise and stable with stateful regexes", () => {
  assert.equal(assertBoundedString("agent", { minBytes: 5, maxBytes: 5, pattern: /^agent$/g }), "agent");
  assert.equal(assertBoundedString("agent", { minBytes: 5, maxBytes: 5, pattern: /^agent$/g }), "agent");
  rejectsWithCode(() => assertBoundedString("🚀", { maxBytes: 3 }), "string_size");
  rejectsWithCode(() => assertBoundedString("observe", { pattern: /^agent$/ }), "string_pattern");
  rejectsWithCode(() => assertBoundedString(1), "expected_string");
});

test("strict parser round-trips 1000 seeded bounded JSON graphs", () => {
  let state = 0x6a09e667;
  const next = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
  const strings = ["", "voice", "quote\"slash\\", "line\nbreak", "café", "🚀"];
  const value = (depth = 0) => {
    const kind = depth >= 4 ? next() % 5 : next() % 7;
    if (kind === 0) return null;
    if (kind === 1) return Boolean(next() & 1);
    if (kind === 2) return (next() % 20_001) - 10_000;
    if (kind === 3) return strings[next() % strings.length];
    if (kind === 4) return (next() % 10_000) / 100;
    if (kind === 5) return Array.from({ length: next() % 5 }, () => value(depth + 1));
    return Object.fromEntries(
      Array.from({ length: next() % 5 }, (_, index) => [`k${depth}_${index}`, value(depth + 1)])
    );
  };
  for (let index = 0; index < 1_000; index += 1) {
    const expected = value();
    const encoded = JSON.stringify(expected);
    assert.deepEqual(parseCappedJson(encoded), expected);
  }
});
