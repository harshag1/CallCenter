// Strict, dependency-free JSON parsing for unauthenticated bridge resources.
// Limits are enforced while parsing so hostile nesting, collections, and strings
// never become an unbounded JavaScript object graph.

const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const NUMBER_PATTERN = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

export const DEFAULT_JSON_LIMITS = Object.freeze({
  maxBytes: 64 * 1024,
  maxChunks: 64,
  maxDepth: 24,
  maxNodes: 4_096,
  maxObjectKeys: 128,
  maxArrayLength: 1_024,
  maxStringBytes: 16 * 1024,
  maxKeyBytes: 256,
  maxNumberChars: 64,
});

// Callers may tighten limits, but cannot accidentally turn this boundary into an
// unlimited parser through configuration.
export const HARD_JSON_LIMITS = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxChunks: 1_024,
  maxDepth: 64,
  maxNodes: 65_536,
  maxObjectKeys: 1_024,
  maxArrayLength: 16_384,
  maxStringBytes: 2 * 1024 * 1024,
  maxKeyBytes: 1_024,
  maxNumberChars: 256,
});

export class JsonResourceError extends Error {
  constructor(code) {
    super("invalid JSON resource");
    this.name = "JsonResourceError";
    this.code = code;
  }
}

function resourceError(code) {
  return new JsonResourceError(code);
}

function normalizeLimits(overrides = {}) {
  if (
    typeof overrides !== "object" ||
    overrides === null ||
    Array.isArray(overrides) ||
    (Object.getPrototypeOf(overrides) !== Object.prototype && Object.getPrototypeOf(overrides) !== null)
  ) {
    throw new TypeError("JSON limits must be a plain object");
  }

  const unknown = Reflect.ownKeys(overrides).filter(
    (key) => typeof key !== "string" || !Object.hasOwn(DEFAULT_JSON_LIMITS, key)
  );
  if (unknown.length) throw new TypeError("JSON limits contain an unknown option");

  const limits = {};
  for (const [key, fallback] of Object.entries(DEFAULT_JSON_LIMITS)) {
    const value = overrides[key] ?? fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > HARD_JSON_LIMITS[key]) {
      throw new RangeError(`invalid JSON limit: ${key}`);
    }
    limits[key] = value;
  }
  return Object.freeze(limits);
}

function binarySegment(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function boundedText(input, maxBytes, maxChunks) {
  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > maxBytes) throw resourceError("max_bytes");
    return input;
  }

  const candidates = Array.isArray(input) ? input : [input];
  if (candidates.length === 0) throw resourceError("invalid_input");
  if (candidates.length > maxChunks) throw resourceError("max_chunks");
  const chunks = [];
  let total = 0;
  for (const candidate of candidates) {
    const chunk = binarySegment(candidate);
    if (!chunk) throw resourceError("invalid_input");
    total += chunk.byteLength;
    if (!Number.isSafeInteger(total) || total > maxBytes) throw resourceError("max_bytes");
    chunks.push(chunk);
  }
  const bytes = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw resourceError("invalid_encoding");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw resourceError("invalid_encoding");
  }
}

function assertWellFormedUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw resourceError("invalid_unicode");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw resourceError("invalid_unicode");
    }
  }
}

class StrictJsonParser {
  constructor(text, limits) {
    this.text = text;
    this.limits = limits;
    this.index = 0;
    this.nodes = 0;
  }

  parse() {
    this.skipWhitespace();
    if (this.index === this.text.length) throw resourceError("invalid_json");
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.text.length) throw resourceError("invalid_json");
    return value;
  }

  countNode() {
    this.nodes += 1;
    if (this.nodes > this.limits.maxNodes) throw resourceError("max_nodes");
  }

  skipWhitespace() {
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break;
      this.index += 1;
    }
  }

  parseValue(depth) {
    this.skipWhitespace();
    this.countNode();
    const char = this.text[this.index];
    if (char === "{") return this.parseObject(depth + 1);
    if (char === "[") return this.parseArray(depth + 1);
    if (char === '"') return this.parseString(false);
    if (char === "t" && this.takeLiteral("true")) return true;
    if (char === "f" && this.takeLiteral("false")) return false;
    if (char === "n" && this.takeLiteral("null")) return null;
    if (char === "-" || (char >= "0" && char <= "9")) return this.parseNumber();
    throw resourceError("invalid_json");
  }

  assertDepth(depth) {
    if (depth > this.limits.maxDepth) throw resourceError("max_depth");
  }

  parseObject(depth) {
    this.assertDepth(depth);
    this.index += 1;
    this.skipWhitespace();
    const result = {};
    const keys = new Set();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return result;
    }
    while (this.index < this.text.length) {
      if (this.text[this.index] !== '"') throw resourceError("invalid_json");
      const key = this.parseString(true);
      if (FORBIDDEN_OBJECT_KEYS.has(key)) throw resourceError("forbidden_key");
      if (keys.has(key)) throw resourceError("duplicate_key");
      keys.add(key);
      if (keys.size > this.limits.maxObjectKeys) throw resourceError("max_object_keys");
      this.skipWhitespace();
      if (this.text[this.index] !== ":") throw resourceError("invalid_json");
      this.index += 1;
      const value = this.parseValue(depth);
      Object.defineProperty(result, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      this.skipWhitespace();
      const delimiter = this.text[this.index];
      if (delimiter === "}") {
        this.index += 1;
        return result;
      }
      if (delimiter !== ",") throw resourceError("invalid_json");
      this.index += 1;
      this.skipWhitespace();
    }
    throw resourceError("invalid_json");
  }

  parseArray(depth) {
    this.assertDepth(depth);
    this.index += 1;
    this.skipWhitespace();
    const result = [];
    if (this.text[this.index] === "]") {
      this.index += 1;
      return result;
    }
    while (this.index < this.text.length) {
      if (result.length >= this.limits.maxArrayLength) throw resourceError("max_array_length");
      result.push(this.parseValue(depth));
      this.skipWhitespace();
      const delimiter = this.text[this.index];
      if (delimiter === "]") {
        this.index += 1;
        return result;
      }
      if (delimiter !== ",") throw resourceError("invalid_json");
      this.index += 1;
      this.skipWhitespace();
    }
    throw resourceError("invalid_json");
  }

  parseString(isKey) {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index);
      if (code === 0x22) {
        this.index += 1;
        let value;
        try {
          value = JSON.parse(this.text.slice(start, this.index));
        } catch {
          throw resourceError("invalid_json");
        }
        assertWellFormedUnicode(value);
        const bytes = Buffer.byteLength(value, "utf8");
        const limit = isKey ? this.limits.maxKeyBytes : this.limits.maxStringBytes;
        if (bytes > limit) throw resourceError(isKey ? "max_key_bytes" : "max_string_bytes");
        return value;
      }
      if (code < 0x20) throw resourceError("invalid_json");
      if (code === 0x5c) {
        this.index += 1;
        const escape = this.text[this.index];
        if (escape === "u") {
          const hex = this.text.slice(this.index + 1, this.index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw resourceError("invalid_json");
          this.index += 5;
          continue;
        }
        if (!['"', "\\", "/", "b", "f", "n", "r", "t"].includes(escape)) {
          throw resourceError("invalid_json");
        }
      }
      this.index += 1;
    }
    throw resourceError("invalid_json");
  }

  parseNumber() {
    NUMBER_PATTERN.lastIndex = this.index;
    const match = NUMBER_PATTERN.exec(this.text);
    if (!match) throw resourceError("invalid_json");
    if (match[0].length > this.limits.maxNumberChars) throw resourceError("max_number_chars");
    this.index = NUMBER_PATTERN.lastIndex;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw resourceError("invalid_number");
    return value;
  }

  takeLiteral(literal) {
    if (!this.text.startsWith(literal, this.index)) return false;
    this.index += literal.length;
    return true;
  }
}

/**
 * Parses a string, Buffer, ArrayBuffer/view, or ws-style array of binary chunks.
 * It rejects duplicate/dangerous object keys and enforces all resource limits
 * before returning an object graph.
 */
export function parseCappedJson(input, options = {}) {
  const limits = normalizeLimits(options);
  const text = boundedText(input, limits.maxBytes, limits.maxChunks);
  return new StrictJsonParser(text, limits).parse();
}

export function assertExactObject(value, { requiredKeys = [], optionalKeys = [] } = {}) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw resourceError("expected_object");
  }
  if (!Array.isArray(requiredKeys) || !Array.isArray(optionalKeys)) {
    throw new TypeError("resource keys must be arrays");
  }
  const all = [...requiredKeys, ...optionalKeys];
  if (all.some((key) => typeof key !== "string") || new Set(all).size !== all.length) {
    throw new TypeError("resource keys must be unique strings");
  }
  const allowed = new Set(all);
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) throw resourceError("missing_key");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) throw resourceError("unexpected_key");
  }
  return value;
}

export function assertBoundedString(
  value,
  { minBytes = 1, maxBytes = 4_096, pattern } = {}
) {
  if (typeof value !== "string") throw resourceError("expected_string");
  if (
    !Number.isSafeInteger(minBytes) ||
    !Number.isSafeInteger(maxBytes) ||
    minBytes < 0 ||
    maxBytes < minBytes ||
    maxBytes > HARD_JSON_LIMITS.maxStringBytes
  ) {
    throw new RangeError("invalid bounded-string limits");
  }
  assertWellFormedUnicode(value);
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < minBytes || bytes > maxBytes) throw resourceError("string_size");
  if (pattern !== undefined) {
    if (!(pattern instanceof RegExp)) throw new TypeError("string pattern must be a RegExp");
    const stablePattern = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""));
    if (!stablePattern.test(value)) throw resourceError("string_pattern");
  }
  return value;
}

/** Parses and applies an exact top-level object shape in one fail-closed step. */
export function parseJsonObjectResource(
  input,
  { requiredKeys = [], optionalKeys = [], limits = {} } = {}
) {
  return assertExactObject(parseCappedJson(input, limits), { requiredKeys, optionalKeys });
}
