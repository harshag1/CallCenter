// Public call-event audit boundary.
//
// Tool arguments/results can contain caller PII, credentials, action leases, or
// application-specific secrets under harmless-looking keys. Public events use
// an allowlist, never a denylist: arbitrary values are not serialized. A
// call-scoped keyed fingerprint preserves deterministic evidence for bounded,
// fully inspected values without publishing plaintext or its length.

import { createHmac, type Hmac } from "node:crypto";

const KEY_DOMAIN = "harshas-amazing-call-center/public-audit-key/v2\n";
const SCOPE_DOMAIN = "harshas-amazing-call-center/public-audit-scope/v2\n";
const ARGUMENT_DOMAIN = "harshas-amazing-call-center/public-tool-arguments/v2\n";
const RESULT_DOMAIN = "harshas-amazing-call-center/public-tool-result/v2\n";
const REDACTED_TOOL_NAME = "[REDACTED_TOOL]";

// Fingerprinting must never become an event-loop or memory denial-of-service
// path. Crossing any bound makes the fingerprint unavailable; a partial digest
// is never returned as equality evidence.
const MAX_FINGERPRINT_DEPTH = 64;
const MAX_FINGERPRINT_VALUES = 10_000;
const MAX_FINGERPRINT_PROPERTIES = 4_096;
const MAX_COLLECTION_ENTRIES = 4_096;
const MAX_FINGERPRINT_INPUT_BYTES = 256 * 1024;
const MAX_PROPERTY_SCAN = MAX_FINGERPRINT_PROPERTIES * 2;
const MAX_SORT_KEY_CHARACTERS = 1_024;

const SAFE_PUBLIC_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_256 = /^[a-f0-9]{64}$/i;

/** Static platform tools are safe public metadata because the set is finite. */
const CORE_PUBLIC_TOOL_NAMES = new Set([
  "begin_step",
  "classify",
  "complete_step",
  "contact_support",
  "end_call",
  "enter_step",
  "get_flow_state",
  "hold",
  "launch_task",
  "log_note",
  "play_hold_music",
  "read_table",
  "request_recall",
  "run_action",
  "search",
  "search_knowledge",
  "send_email",
  "send_sms",
  "write_table",
]);

const PUBLIC_RESULT_STATUSES = new Set([
  "cancelled",
  "completed",
  "failed",
  "indeterminate",
  "ok",
  "pending",
  "rejected",
  "reserved",
  "succeeded",
]);

export type PublicAuditScalar = string | number | boolean;

export type PublicAuditFingerprintScope = Readonly<{
  /** Stable tenant boundary; used only for key derivation and never emitted. */
  organizationId: string;
  /** Stable call boundary; used only for key derivation and never emitted. */
  callId: string;
}>;

export type PublicAuditOptions = Readonly<{
  /**
   * A CSPRNG-generated 32-byte server secret. Strings must be exactly 64 hex
   * characters (the format produced by `openssl rand -hex 32`).
   */
  fingerprintKey?: string | Uint8Array;
  /** Required for a fingerprint and prevents cross-tenant/call correlation. */
  fingerprintScope?: PublicAuditFingerprintScope;
  /**
   * Dynamic tool names already verified against the pinned runtime catalog.
   * Unverified/hallucinated names are rendered as `[REDACTED_TOOL]`.
   */
  trustedToolNames?: readonly string[];
  /**
   * Exact metadata values derived from trusted runtime state (flow paths/topic
   * ids, dataset slugs, action catalog, receipt ledger). Merely looking like an
   * identifier is not enough. Keys remain restricted by this module's policy.
   */
  trustedMetadataValues?: Readonly<Record<string, readonly PublicAuditScalar[]>>;
}>;

export type PublicToolAuditOptions = PublicAuditOptions & Readonly<{
  audience?: "realtime" | "background";
}>;

export type PublicAuditMarker = Readonly<{
  schema_version: 2;
  redaction: "trusted_top_level_allowlist_only";
  fingerprint_algorithm: "call-scoped-hmac-sha256-v2" | null;
  fingerprint_complete: boolean;
  fingerprint_hmac_sha256: string | null;
}>;

export type PublicAuditProjection = Readonly<{
  _audit: PublicAuditMarker;
  [key: string]: unknown;
}>;

export type PublicToolCallAuditPayload = Readonly<{
  name: string;
  args: PublicAuditProjection;
  audience?: "realtime" | "background";
}>;

export type PublicToolResultAuditPayload = Readonly<{
  name: string;
  result: PublicAuditProjection;
  audience?: "realtime" | "background";
}>;

type MetadataRule = Readonly<{
  key: string;
  source: "trusted_identifier" | "trusted_uuid" | "trusted_tool" | "fixed_enum" | "boolean";
  values?: ReadonlySet<string>;
}>;

const TOOL_ARGUMENT_METADATA = Object.freeze<Record<string, readonly MetadataRule[]>>({
  classify: Object.freeze([{ key: "topic", source: "trusted_identifier" }]),
  begin_step: Object.freeze([
    { key: "topic", source: "trusted_identifier" },
    { key: "step", source: "trusted_identifier" },
  ]),
  enter_step: Object.freeze([{ key: "path", source: "trusted_identifier" }]),
  complete_step: Object.freeze([{ key: "path", source: "trusted_identifier" }]),
  run_action: Object.freeze([{ key: "name", source: "trusted_tool" }]),
  read_table: Object.freeze([{ key: "table", source: "trusted_identifier" }]),
  write_table: Object.freeze([{ key: "table", source: "trusted_identifier" }]),
  launch_task: Object.freeze([{
    key: "when",
    source: "fixed_enum",
    values: new Set(["now", "end_of_call"]),
  }]),
});

const TOOL_RESULT_METADATA = Object.freeze<readonly MetadataRule[]>([
  { key: "status", source: "fixed_enum", values: PUBLIC_RESULT_STATUSES },
  { key: "code", source: "trusted_identifier" },
  { key: "receipt_id", source: "trusted_uuid" },
  { key: "replayed", source: "boolean" },
  { key: "pending", source: "boolean" },
]);

const NO_VALUE = Symbol("no-public-audit-value");

function ownDataValue(value: unknown, key: string): unknown | typeof NO_VALUE {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return NO_VALUE;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : NO_VALUE;
  } catch {
    return NO_VALUE;
  }
}

/** Reads a bounded dense array through descriptors so hostile getters never execute. */
function ownArrayDataValues(value: unknown): unknown[] | null {
  try {
    if (!Array.isArray(value)) return null;
    const length = ownDataValue(value, "length");
    if (
      typeof length !== "number"
      || !Number.isSafeInteger(length)
      || length < 0
      || length > MAX_COLLECTION_ENTRIES
    ) return null;
    const values: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const candidate = ownDataValue(value, String(index));
      if (candidate === NO_VALUE) return null;
      values.push(candidate);
    }
    return values;
  } catch {
    return null;
  }
}

function validPublicIdentifier(value: unknown): value is string {
  return typeof value === "string" && SAFE_PUBLIC_IDENTIFIER.test(value);
}

function trustedValues(options: PublicAuditOptions, key: string): readonly PublicAuditScalar[] {
  const metadata = ownDataValue(options, "trustedMetadataValues");
  const candidate = ownDataValue(metadata, key);
  const values = ownArrayDataValues(candidate);
  if (!values) return [];
  return values.filter((entry): entry is PublicAuditScalar =>
    typeof entry === "string" || typeof entry === "boolean" ||
    (typeof entry === "number" && Number.isFinite(entry))
  );
}

function exactlyTrusted(value: unknown, options: PublicAuditOptions, key: string): value is PublicAuditScalar {
  return trustedValues(options, key).some((candidate) => Object.is(candidate, value));
}

function trustedToolName(value: unknown, options: PublicAuditOptions): value is string {
  if (!validPublicIdentifier(value)) return false;
  if (CORE_PUBLIC_TOOL_NAMES.has(value)) return true;
  const catalog = ownArrayDataValues(ownDataValue(options, "trustedToolNames"));
  return Boolean(catalog?.some((entry) => entry === value));
}

function safeToolName(value: unknown, options: PublicAuditOptions): string {
  return trustedToolName(value, options) ? value : REDACTED_TOOL_NAME;
}

function allowedMetadataValue(
  value: unknown,
  rule: MetadataRule,
  options: PublicAuditOptions
): string | number | boolean | null {
  switch (rule.source) {
    case "trusted_identifier":
      return validPublicIdentifier(value) && exactlyTrusted(value, options, rule.key) ? value : null;
    case "trusted_uuid":
      return typeof value === "string" && UUID.test(value) && exactlyTrusted(value, options, rule.key)
        ? value
        : null;
    case "trusted_tool":
      return trustedToolName(value, options) ? value : null;
    case "fixed_enum":
      return typeof value === "string" && rule.values?.has(value) ? value : null;
    case "boolean":
      return typeof value === "boolean" ? value : null;
  }
}

function projectMetadata(
  value: unknown,
  rules: readonly MetadataRule[],
  options: PublicAuditOptions
): Record<string, string | number | boolean> {
  const projected: Record<string, string | number | boolean> = {};
  for (const rule of rules) {
    const candidate = ownDataValue(value, rule.key);
    if (candidate === NO_VALUE) continue;
    const safe = allowedMetadataValue(candidate, rule, options);
    if (safe !== null) projected[rule.key] = safe;
  }
  return projected;
}

function normalizeFingerprintKey(value: unknown): Buffer | null {
  try {
    const key = typeof value === "string" && HEX_256.test(value)
      ? Buffer.from(value, "hex")
      : value instanceof Uint8Array && value.byteLength === 32
        ? Buffer.from(value)
        : null;
    if (!key || key.byteLength !== 32) return null;
    // This cannot prove entropy, but catches placeholder/all-zero/repeated keys.
    if (new Set(key).size < 8) return null;
    return key;
  } catch {
    return null;
  }
}

function normalizeFingerprintScope(
  value: unknown
): PublicAuditFingerprintScope | null {
  const organizationId = ownDataValue(value, "organizationId");
  const callId = ownDataValue(value, "callId");
  return typeof organizationId === "string" && organizationId.length > 0 && organizationId.length <= 256 &&
    typeof callId === "string" && callId.length > 0 && callId.length <= 256
    ? Object.freeze({ organizationId, callId })
    : null;
}

function propertySortKey(key: string): string {
  return `property:${key}`;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function primitiveSortKey(value: unknown): string | null {
  if (value === null) return "0:null";
  switch (typeof value) {
    case "undefined": return "1:undefined";
    case "boolean": return value ? "2:true" : "2:false";
    case "number":
      if (Number.isNaN(value)) return "3:nan";
      if (Object.is(value, -0)) return "3:0";
      return `3:${String(value)}`;
    case "bigint": return null;
    case "string": return value.length <= MAX_SORT_KEY_CHARACTERS ? `5:${value}` : null;
    case "symbol": return null;
    default: return null;
  }
}

function arrayBufferViewKind(value: ArrayBufferView): string {
  if (value instanceof DataView) return "data_view";
  if (value instanceof Int8Array) return "int8_array";
  if (value instanceof Uint8ClampedArray) return "uint8_clamped_array";
  if (value instanceof Uint8Array) return "uint8_array";
  if (value instanceof Int16Array) return "int16_array";
  if (value instanceof Uint16Array) return "uint16_array";
  if (value instanceof Int32Array) return "int32_array";
  if (value instanceof Uint32Array) return "uint32_array";
  if (value instanceof Float32Array) return "float32_array";
  if (value instanceof Float64Array) return "float64_array";
  if (typeof BigInt64Array !== "undefined" && value instanceof BigInt64Array) return "bigint64_array";
  if (typeof BigUint64Array !== "undefined" && value instanceof BigUint64Array) return "biguint64_array";
  return "unknown_array_buffer_view";
}

/** Streams a bounded canonical representation directly into HMAC. */
class CanonicalHmacEncoder {
  readonly seen = new Map<object, number>();
  complete = true;
  private valueCount = 0;
  private propertyCount = 0;
  private inputBytes = 0;

  constructor(private readonly hmac: Hmac) {}

  private failIncomplete(): void {
    this.complete = false;
  }

  private consumeValue(): boolean {
    this.valueCount += 1;
    if (this.valueCount > MAX_FINGERPRINT_VALUES) this.failIncomplete();
    return this.complete;
  }

  private consumeProperty(): boolean {
    this.propertyCount += 1;
    if (this.propertyCount > MAX_FINGERPRINT_PROPERTIES) this.failIncomplete();
    return this.complete;
  }

  private consumeBytes(byteLength: number): boolean {
    this.inputBytes += byteLength;
    if (!Number.isSafeInteger(this.inputBytes) || this.inputBytes > MAX_FINGERPRINT_INPUT_BYTES) {
      this.failIncomplete();
    }
    return this.complete;
  }

  private token(value: string): void {
    if (!this.complete) return;
    this.hmac.update(value, "utf8");
    this.hmac.update(";", "utf8");
  }

  private text(tag: string, value: string): void {
    if (!this.complete) return;
    // Avoid even scanning an obviously over-budget string for its UTF-8 length.
    if (value.length > MAX_FINGERPRINT_INPUT_BYTES) {
      this.failIncomplete();
      return;
    }
    const byteLength = Buffer.byteLength(value, "utf8");
    if (!this.consumeBytes(byteLength)) return;
    this.hmac.update(`${tag}:${byteLength}:`, "utf8");
    this.hmac.update(value, "utf8");
    this.hmac.update(";", "utf8");
  }

  private bytes(tag: string, value: Uint8Array): void {
    if (!this.complete || !this.consumeBytes(value.byteLength)) return;
    this.hmac.update(`${tag}:${value.byteLength}:`, "utf8");
    this.hmac.update(value);
    this.hmac.update(";", "utf8");
  }

  encode(value: unknown, depth = 0): void {
    if (!this.complete || !this.consumeValue()) return;
    if (depth > MAX_FINGERPRINT_DEPTH) {
      this.failIncomplete();
      return;
    }
    if (value === null) {
      this.token("null");
      return;
    }
    switch (typeof value) {
      case "undefined": this.token("undefined"); return;
      case "boolean": this.token(value ? "boolean:true" : "boolean:false"); return;
      case "number":
        if (Number.isNaN(value)) this.token("number:nan");
        else if (value === Infinity) this.token("number:positive_infinity");
        else if (value === -Infinity) this.token("number:negative_infinity");
        else if (Object.is(value, -0)) this.token("number:negative_zero");
        else this.text("number", String(value));
        return;
      // BigInt conversion cost is proportional to an otherwise unbounded
      // magnitude and BigInt is not a provider JSON value. Fail closed.
      case "bigint": this.failIncomplete(); return;
      case "string": this.text("string", value); return;
      // Local symbol identity and function closure state cannot be recovered
      // without executing/observing opaque runtime state. Refuse equality
      // evidence instead of hashing a description or source-code lookalike.
      case "symbol": this.failIncomplete(); return;
      case "function": this.failIncomplete(); return;
      case "object": this.encodeObject(value, depth); return;
    }
  }

  private beginComposite(value: object): boolean {
    const reference = this.seen.get(value);
    if (reference !== undefined) {
      this.text("reference", String(reference));
      return false;
    }
    this.seen.set(value, this.seen.size);
    return true;
  }

  private encodeObject(value: object, depth: number): void {
    if (!this.beginComposite(value)) return;
    try {
      if (ArrayBuffer.isView(value)) {
        const view = value as ArrayBufferView;
        this.token(arrayBufferViewKind(view));
        this.bytes("bytes", new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
        return;
      }
      if (value instanceof ArrayBuffer) {
        this.token("array_buffer");
        this.bytes("bytes", new Uint8Array(value));
        return;
      }
      if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) {
        this.token("shared_array_buffer");
        this.bytes("bytes", new Uint8Array(value));
        return;
      }
      if (value instanceof Date) {
        this.text("date", String(Date.prototype.getTime.call(value)));
        return;
      }
      if (value instanceof RegExp) {
        const source = Object.getOwnPropertyDescriptor(RegExp.prototype, "source")?.get?.call(value);
        const flags = Object.getOwnPropertyDescriptor(RegExp.prototype, "flags")?.get?.call(value);
        this.text("regexp_source", typeof source === "string" ? source : "");
        this.text("regexp_flags", typeof flags === "string" ? flags : "");
        return;
      }
      if (value instanceof URL) {
        this.text("url", URL.prototype.toString.call(value));
        return;
      }
      if (value instanceof Error) {
        const name = ownDataValue(value, "name");
        const message = ownDataValue(value, "message");
        const cause = ownDataValue(value, "cause");
        this.text("error_name", typeof name === "string" ? name : "Error");
        this.text("error_message", typeof message === "string" ? message : "");
        if (cause !== NO_VALUE) this.encode(cause, depth + 1);
        this.encodeEnumerableProperties(value, "object", depth);
        return;
      }
      if (value instanceof Map) {
        this.encodeMap(value, depth);
        return;
      }
      if (value instanceof Set) {
        this.encodeSet(value, depth);
        return;
      }
      if (Array.isArray(value)) {
        const length = ownDataValue(value, "length");
        if (typeof length !== "number" || !Number.isSafeInteger(length) || length > MAX_COLLECTION_ENTRIES) {
          this.failIncomplete();
          return;
        }
        this.text("array_length", String(length));
        this.encodeEnumerableProperties(value, "array", depth);
        return;
      }
      this.encodeEnumerableProperties(value, "object", depth);
    } catch {
      this.failIncomplete();
    }
  }

  private encodeMap(value: Map<unknown, unknown>, depth: number): void {
    const size = Object.getOwnPropertyDescriptor(Map.prototype, "size")?.get?.call(value);
    if (typeof size !== "number" || size > MAX_COLLECTION_ENTRIES) {
      this.failIncomplete();
      return;
    }
    const entries: { sortKey: string; key: unknown; value: unknown }[] = [];
    for (const [key, item] of Map.prototype.entries.call(value) as MapIterator<[unknown, unknown]>) {
      const sortKey = primitiveSortKey(key);
      if (sortKey === null) {
        this.failIncomplete();
        return;
      }
      entries.push({ sortKey, key, value: item });
    }
    entries.sort((left, right) => compareCodeUnits(left.sortKey, right.sortKey));
    if (entries.some((entry, index) => index > 0 && entry.sortKey === entries[index - 1].sortKey)) {
      this.failIncomplete();
      return;
    }
    this.token("map_start");
    for (const entry of entries) {
      this.token("map_entry");
      this.encode(entry.key, depth + 1);
      this.encode(entry.value, depth + 1);
    }
    this.token("map_end");
  }

  private encodeSet(value: Set<unknown>, depth: number): void {
    const size = Object.getOwnPropertyDescriptor(Set.prototype, "size")?.get?.call(value);
    if (typeof size !== "number" || size > MAX_COLLECTION_ENTRIES) {
      this.failIncomplete();
      return;
    }
    const entries: { sortKey: string; value: unknown }[] = [];
    for (const item of Set.prototype.values.call(value) as SetIterator<unknown>) {
      const sortKey = primitiveSortKey(item);
      if (sortKey === null) {
        this.failIncomplete();
        return;
      }
      entries.push({ sortKey, value: item });
    }
    entries.sort((left, right) => compareCodeUnits(left.sortKey, right.sortKey));
    if (entries.some((entry, index) => index > 0 && entry.sortKey === entries[index - 1].sortKey)) {
      this.failIncomplete();
      return;
    }
    this.token("set_start");
    for (const entry of entries) this.encode(entry.value, depth + 1);
    this.token("set_end");
  }

  private encodeEnumerableProperties(
    value: object,
    kind: "array" | "object",
    depth: number
  ): void {
    const keys: string[] = [];
    let scanned = 0;
    // Deliberately model provider/JSON argument semantics: own enumerable string
    // properties. This avoids materializing every descriptor before enforcing a
    // cap, and accessors are described but never invoked.
    for (const key in value) {
      scanned += 1;
      if (scanned > MAX_PROPERTY_SCAN) {
        this.failIncomplete();
        return;
      }
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      keys.push(key);
      if (keys.length > MAX_FINGERPRINT_PROPERTIES) {
        this.failIncomplete();
        return;
      }
    }
    keys.sort((left, right) => compareCodeUnits(propertySortKey(left), propertySortKey(right)));
    this.token(`${kind}_start`);
    for (const key of keys) {
      if (!this.consumeProperty()) return;
      this.text("property", key);
      if (!this.complete) return;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) {
        this.failIncomplete();
        return;
      }
      if ("value" in descriptor) {
        this.token("data_property");
        this.encode(descriptor.value, depth + 1);
      } else {
        // JSON serialization/tool dispatch may observe an accessor's return
        // value, but reading it here would execute untrusted code. Its function
        // source cannot represent captured closure state, so fail incomplete.
        this.failIncomplete();
        return;
      }
      if (!this.complete) return;
    }
    this.token(`${kind}_end`);
  }
}

type FingerprintResult = Readonly<{ value: string | null; complete: boolean }>;

function keyedFingerprint(
  domain: string,
  toolName: string,
  value: unknown,
  options: PublicAuditOptions
): FingerprintResult {
  const sourceKey = normalizeFingerprintKey(ownDataValue(options, "fingerprintKey"));
  const scope = normalizeFingerprintScope(ownDataValue(options, "fingerprintScope"));
  if (!sourceKey || !scope) return Object.freeze({ value: null, complete: false });
  try {
    const rootKey = createHmac("sha256", sourceKey).update(KEY_DOMAIN, "utf8").digest();
    const scopedKeyHmac = createHmac("sha256", rootKey).update(SCOPE_DOMAIN, "utf8");
    const scopeEncoder = new CanonicalHmacEncoder(scopedKeyHmac);
    scopeEncoder.encode(scope.organizationId);
    scopeEncoder.encode(scope.callId);
    if (!scopeEncoder.complete) return Object.freeze({ value: null, complete: false });
    const scopedKey = scopedKeyHmac.digest();

    const hmac = createHmac("sha256", scopedKey).update(domain, "utf8");
    const encoder = new CanonicalHmacEncoder(hmac);
    encoder.encode(toolName);
    encoder.encode(value);
    if (!encoder.complete) return Object.freeze({ value: null, complete: false });
    return Object.freeze({ value: hmac.digest("hex"), complete: true });
  } catch {
    return Object.freeze({ value: null, complete: false });
  }
}

function marker(fingerprint: FingerprintResult): PublicAuditMarker {
  return Object.freeze({
    schema_version: 2 as const,
    redaction: "trusted_top_level_allowlist_only" as const,
    fingerprint_algorithm: fingerprint.complete ? "call-scoped-hmac-sha256-v2" as const : null,
    fingerprint_complete: fingerprint.complete,
    fingerprint_hmac_sha256: fingerprint.complete ? fingerprint.value : null,
  });
}

function frozenProjection(
  metadata: Record<string, string | number | boolean>,
  fingerprint: FingerprintResult
): PublicAuditProjection {
  return Object.freeze({ ...metadata, _audit: marker(fingerprint) });
}

/**
 * Projects arguments for a publicly readable call event. `run_action.arguments`
 * and every other non-authorized value are fingerprinted but never returned.
 */
export function publicAuditToolArguments(
  toolName: string,
  args: unknown,
  options: PublicAuditOptions = {}
): PublicAuditProjection {
  const configuredRules = typeof toolName === "string"
    ? ownDataValue(TOOL_ARGUMENT_METADATA, toolName)
    : NO_VALUE;
  const rules = Array.isArray(configuredRules) ? configuredRules : [];
  const metadata = projectMetadata(args, rules, options);
  return frozenProjection(metadata, keyedFingerprint(ARGUMENT_DOMAIN, toolName, args, options));
}

/** Projects a tool result without publishing arbitrary result values/error text. */
export function publicAuditToolResult(
  toolName: string,
  result: unknown,
  options: PublicAuditOptions = {}
): PublicAuditProjection {
  const metadata = projectMetadata(result, TOOL_RESULT_METADATA, options);
  return frozenProjection(metadata, keyedFingerprint(RESULT_DOMAIN, toolName, result, options));
}

/** Ready-to-persist payload for the existing `tool_call` call-event shape. */
export function publicAuditToolCallPayload(
  toolName: string,
  args: unknown,
  options: PublicToolAuditOptions = {}
): PublicToolCallAuditPayload {
  const audience = ownDataValue(options, "audience");
  return Object.freeze({
    name: safeToolName(toolName, options),
    args: publicAuditToolArguments(toolName, args, options),
    ...(audience === "realtime" || audience === "background"
      ? { audience }
      : {}),
  });
}

/** Ready-to-persist payload for the existing `tool_result` call-event shape. */
export function publicAuditToolResultPayload(
  toolName: string,
  result: unknown,
  options: PublicToolAuditOptions = {}
): PublicToolResultAuditPayload {
  const audience = ownDataValue(options, "audience");
  return Object.freeze({
    name: safeToolName(toolName, options),
    result: publicAuditToolResult(toolName, result, options),
    ...(audience === "realtime" || audience === "background"
      ? { audience }
      : {}),
  });
}
