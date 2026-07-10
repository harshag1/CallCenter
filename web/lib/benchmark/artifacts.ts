import { createHash } from "node:crypto";

/** JSON values accepted by the benchmark artifact format. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type BenchmarkEventEnvelope<TPayload extends JsonValue = JsonValue> = Readonly<{
  schema_version: 1;
  run_id: string;
  sequence: number;
  observed_at: string;
  event_type: string;
  payload: TPayload;
  previous_hash: string | null;
  payload_hash: string;
  event_hash: string;
}>;

export type EventChainVerification = Readonly<{
  valid: boolean;
  event_count: number;
  run_id: string | null;
  chain_head: string | null;
  errors: readonly string[];
}>;

export type ArtifactDescriptor = Readonly<{
  path: string;
  media_type: string;
  byte_length: number;
  sha256: string;
}>;

export type EventLogReference = Readonly<{
  path: string;
  event_count: number;
  chain_head: string | null;
}>;

export type RunManifest = Readonly<{
  schema_version: 1;
  run_id: string;
  created_at: string;
  artifacts: readonly ArtifactDescriptor[];
  event_log: EventLogReference | null;
  metadata: JsonValue;
  manifest_hash: string;
}>;

export type ManifestVerification = Readonly<{
  valid: boolean;
  expected_manifest_hash: string | null;
  errors: readonly string[];
}>;

const EVENT_HASH_DOMAIN = "harshas-amazing-call-center/voice-benchmark-event/v1\n";
const PAYLOAD_HASH_DOMAIN = "harshas-amazing-call-center/voice-benchmark-payload/v1\n";
const MANIFEST_HASH_DOMAIN = "harshas-amazing-call-center/voice-benchmark-manifest/v1\n";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const EVENT_KEYS = Object.freeze([
  "schema_version",
  "run_id",
  "sequence",
  "observed_at",
  "event_type",
  "payload",
  "previous_hash",
  "payload_hash",
  "event_hash",
].sort());
const MANIFEST_KEYS = Object.freeze([
  "schema_version",
  "run_id",
  "created_at",
  "artifacts",
  "event_log",
  "metadata",
  "manifest_hash",
].sort());
const ARTIFACT_KEYS = Object.freeze(["path", "media_type", "byte_length", "sha256"].sort());
const EVENT_LOG_KEYS = Object.freeze(["path", "event_count", "chain_head"].sort());

function hasExactlyKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function assertNonEmptyString(value: unknown, label: string, maxLength = 512): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(`${label} must be a non-empty string of at most ${maxLength} characters`);
  }
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp`);
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

function normalizeJson(value: unknown, path: string, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`);
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error(`${path} contains an integer outside JSON-safe precision`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    throw new Error(`${path} contains a value that is not JSON-serializable`);
  }
  if (ancestors.has(value)) throw new Error(`${path} contains a cycle`);
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const normalized: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new Error(`${path}[${index}] is a sparse array entry`);
        }
        normalized.push(normalizeJson(value[index], `${path}[${index}]`, ancestors));
      }
      return normalized;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} must contain only plain JSON objects`);
    }
    const record = value as Record<string, unknown>;
    const normalized: Record<string, JsonValue> = {};
    for (const key of Object.keys(record).sort()) {
      normalized[key] = normalizeJson(record[key], `${path}.${key}`, ancestors);
    }
    return normalized;
  } finally {
    ancestors.delete(value);
  }
}

function deepFreezeJson<T extends JsonValue>(value: T): T {
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value)) {
      for (const item of value) deepFreezeJson(item);
    } else {
      for (const item of Object.values(value)) deepFreezeJson(item);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Convert an unknown value to a detached, sorted, deeply frozen JSON value.
 * Rejecting Dates, undefined, sparse arrays, and non-finite numbers prevents
 * different runtimes from silently hashing different representations.
 */
export function immutableJson(value: unknown): JsonValue {
  return deepFreezeJson(normalizeJson(value, "$", new Set()));
}

/** RFC-8259 JSON with recursively sorted object keys. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value, "$", new Set()));
}

export function sha256Hex(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function domainHash(domain: string, value: unknown): string {
  return sha256Hex(`${domain}${canonicalJson(value)}`);
}

function eventBody<TPayload extends JsonValue>(
  envelope: Omit<BenchmarkEventEnvelope<TPayload>, "event_hash">
): Omit<BenchmarkEventEnvelope<TPayload>, "event_hash"> {
  return {
    schema_version: envelope.schema_version,
    run_id: envelope.run_id,
    sequence: envelope.sequence,
    observed_at: envelope.observed_at,
    event_type: envelope.event_type,
    payload: envelope.payload,
    previous_hash: envelope.previous_hash,
    payload_hash: envelope.payload_hash,
  };
}

function createEnvelope<TPayload extends JsonValue>(input: {
  run_id: string;
  sequence: number;
  observed_at: string;
  event_type: string;
  payload: TPayload;
  previous_hash: string | null;
}): BenchmarkEventEnvelope<TPayload> {
  assertNonEmptyString(input.run_id, "run_id", 256);
  assertTimestamp(input.observed_at, "observed_at");
  assertNonEmptyString(input.event_type, "event_type", 256);
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
    throw new Error("sequence must be a non-negative safe integer");
  }
  if (input.previous_hash !== null) assertSha256(input.previous_hash, "previous_hash");

  const payload = immutableJson(input.payload) as TPayload;
  const payloadHash = domainHash(PAYLOAD_HASH_DOMAIN, payload);
  const withoutHash: Omit<BenchmarkEventEnvelope<TPayload>, "event_hash"> = {
    schema_version: 1,
    run_id: input.run_id,
    sequence: input.sequence,
    observed_at: input.observed_at,
    event_type: input.event_type,
    payload,
    previous_hash: input.previous_hash,
    payload_hash: payloadHash,
  };
  const eventHash = domainHash(EVENT_HASH_DOMAIN, eventBody(withoutHash));
  return Object.freeze({ ...withoutHash, event_hash: eventHash });
}

export function startEventChain<TPayload extends JsonValue>(input: {
  run_id: string;
  observed_at: string;
  event_type: string;
  payload: TPayload;
}): BenchmarkEventEnvelope<TPayload> {
  return createEnvelope({ ...input, sequence: 0, previous_hash: null });
}

export function appendEventEnvelope<TPayload extends JsonValue>(
  previous: BenchmarkEventEnvelope,
  input: {
    observed_at: string;
    event_type: string;
    payload: TPayload;
  }
): BenchmarkEventEnvelope<TPayload> {
  const keyError = eventKeyError(previous, previous.sequence);
  if (keyError) throw new Error(`Cannot append to an invalid event: ${keyError}`);
  if (previous.schema_version !== 1) throw new Error("Cannot append to an unsupported event schema");
  assertNonEmptyString(previous.run_id, "previous.run_id", 256);
  assertTimestamp(previous.observed_at, "previous.observed_at");
  assertNonEmptyString(previous.event_type, "previous.event_type", 256);
  if (!Number.isSafeInteger(previous.sequence) || previous.sequence < 0) {
    throw new Error("Cannot append to an event with an invalid sequence");
  }
  if (previous.previous_hash !== null) assertSha256(previous.previous_hash, "previous.previous_hash");
  assertSha256(previous.payload_hash, "previous.payload_hash");
  assertSha256(previous.event_hash, "previous.event_hash");
  const expectedPayloadHash = domainHash(PAYLOAD_HASH_DOMAIN, previous.payload);
  const expectedEventHash = domainHash(EVENT_HASH_DOMAIN, eventBody(previous));
  if (previous.payload_hash !== expectedPayloadHash || previous.event_hash !== expectedEventHash) {
    throw new Error("Cannot append to an event whose content hash is invalid");
  }
  return createEnvelope({
    ...input,
    run_id: previous.run_id,
    sequence: previous.sequence + 1,
    previous_hash: previous.event_hash,
  });
}

export function buildEventChain(
  runId: string,
  events: readonly Readonly<{
    observed_at: string;
    event_type: string;
    payload: JsonValue;
  }>[]
): readonly BenchmarkEventEnvelope[] {
  if (events.length === 0) return Object.freeze([]);
  const chain: BenchmarkEventEnvelope[] = [
    startEventChain({ run_id: runId, ...events[0] }),
  ];
  for (let index = 1; index < events.length; index += 1) {
    chain.push(appendEventEnvelope(chain[index - 1], events[index]));
  }
  return Object.freeze(chain);
}

function eventKeyError(event: unknown, index: number): string | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return `event[${index}] is not an object`;
  }
  const keys = Object.keys(event).sort();
  if (keys.length !== EVENT_KEYS.length || keys.some((key, keyIndex) => key !== EVENT_KEYS[keyIndex])) {
    return `event[${index}] has missing or unsupported fields`;
  }
  return null;
}

export function verifyEventChain(events: readonly BenchmarkEventEnvelope[]): EventChainVerification {
  const errors: string[] = [];
  let runId: string | null = null;
  let previousHash: string | null = null;

  events.forEach((event, index) => {
    const keyError = eventKeyError(event, index);
    if (keyError) {
      errors.push(keyError);
      return;
    }

    try {
      if (event.schema_version !== 1) errors.push(`event[${index}] has an unsupported schema_version`);
      assertNonEmptyString(event.run_id, `event[${index}].run_id`, 256);
      assertTimestamp(event.observed_at, `event[${index}].observed_at`);
      assertNonEmptyString(event.event_type, `event[${index}].event_type`, 256);
      assertSha256(event.payload_hash, `event[${index}].payload_hash`);
      assertSha256(event.event_hash, `event[${index}].event_hash`);
      if (!Number.isSafeInteger(event.sequence) || event.sequence < 0) {
        errors.push(`event[${index}].sequence is invalid`);
      }
      if (event.sequence !== index) errors.push(`event[${index}] expected sequence ${index}`);
      if (index === 0) runId = event.run_id;
      if (event.run_id !== runId) errors.push(`event[${index}] changes run_id`);
      if (event.previous_hash !== previousHash) errors.push(`event[${index}] breaks the previous_hash chain`);

      const expectedPayloadHash = domainHash(PAYLOAD_HASH_DOMAIN, event.payload);
      if (event.payload_hash !== expectedPayloadHash) errors.push(`event[${index}] payload_hash mismatch`);
      const expectedEventHash = domainHash(EVENT_HASH_DOMAIN, eventBody(event));
      if (event.event_hash !== expectedEventHash) errors.push(`event[${index}] event_hash mismatch`);
    } catch (error) {
      errors.push(`event[${index}] ${error instanceof Error ? error.message : "is invalid"}`);
    }

    previousHash = typeof event.event_hash === "string" ? event.event_hash : null;
  });

  return Object.freeze({
    valid: errors.length === 0,
    event_count: events.length,
    run_id: runId,
    chain_head: events.length > 0 && typeof events[events.length - 1]?.event_hash === "string"
      ? events[events.length - 1].event_hash
      : null,
    errors: Object.freeze(errors),
  });
}

/** Encode only valid chains, one canonical envelope per line. */
export function encodeEventJsonl(events: readonly BenchmarkEventEnvelope[]): string {
  const verification = verifyEventChain(events);
  if (!verification.valid) throw new Error(`Invalid event chain: ${verification.errors.join("; ")}`);
  return events.length === 0 ? "" : `${events.map(canonicalJson).join("\n")}\n`;
}

export function decodeEventJsonl(
  jsonl: string,
  options: { verify?: boolean } = {}
): readonly BenchmarkEventEnvelope[] {
  if (typeof jsonl !== "string") throw new Error("JSONL input must be a string");
  if (jsonl.length === 0) return Object.freeze([]);
  const lines = jsonl.endsWith("\n") ? jsonl.slice(0, -1).split("\n") : jsonl.split("\n");
  if (lines.some((line) => line.trim().length === 0)) throw new Error("JSONL contains a blank record");
  const parsed = lines.map((line, index) => {
    try {
      return JSON.parse(line) as BenchmarkEventEnvelope;
    } catch (error) {
      throw new Error(`Invalid JSON at JSONL record ${index}: ${error instanceof Error ? error.message : error}`);
    }
  });
  if (options.verify !== false) {
    const verification = verifyEventChain(parsed);
    if (!verification.valid) throw new Error(`Invalid event chain: ${verification.errors.join("; ")}`);
  }
  return Object.freeze(parsed.map((event) =>
    immutableJson(event) as unknown as BenchmarkEventEnvelope
  ));
}

function assertArtifactPath(path: unknown): asserts path is string {
  assertNonEmptyString(path, "artifact path", 1024);
  if (
    path.startsWith("/")
    || path.includes("\\")
    || path.includes("\0")
    || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Artifact path must be a normalized relative POSIX path: ${path}`);
  }
}

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);
}

export function createArtifactDescriptor(
  path: string,
  content: string | Uint8Array,
  mediaType = "application/octet-stream"
): ArtifactDescriptor {
  assertArtifactPath(path);
  assertNonEmptyString(mediaType, "media_type", 256);
  const bytes = toBytes(content);
  return Object.freeze({
    path,
    media_type: mediaType,
    byte_length: bytes.byteLength,
    sha256: sha256Hex(bytes),
  });
}

function descriptorErrors(descriptor: ArtifactDescriptor, index: number): string[] {
  const errors: string[] = [];
  try {
    if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
      throw new Error(`artifacts[${index}] is not an object`);
    }
    if (!hasExactlyKeys(descriptor, ARTIFACT_KEYS)) {
      errors.push(`artifacts[${index}] has missing or unsupported fields`);
    }
    assertArtifactPath(descriptor.path);
    assertNonEmptyString(descriptor.media_type, `artifacts[${index}].media_type`, 256);
    if (!Number.isSafeInteger(descriptor.byte_length) || descriptor.byte_length < 0) {
      errors.push(`artifacts[${index}].byte_length is invalid`);
    }
    assertSha256(descriptor.sha256, `artifacts[${index}].sha256`);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : `artifacts[${index}] is invalid`);
  }
  return errors;
}

function manifestBody(manifest: Omit<RunManifest, "manifest_hash">): Omit<RunManifest, "manifest_hash"> {
  return {
    schema_version: manifest.schema_version,
    run_id: manifest.run_id,
    created_at: manifest.created_at,
    artifacts: manifest.artifacts,
    event_log: manifest.event_log,
    metadata: manifest.metadata,
  };
}

export function createRunManifest(input: {
  run_id: string;
  created_at: string;
  artifacts: readonly ArtifactDescriptor[];
  event_log?: EventLogReference | null;
  metadata?: unknown;
}): RunManifest {
  assertNonEmptyString(input.run_id, "run_id", 256);
  assertTimestamp(input.created_at, "created_at");
  const artifacts = [...input.artifacts].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
  const seenPaths = new Set<string>();
  artifacts.forEach((descriptor, index) => {
    const errors = descriptorErrors(descriptor, index);
    if (errors.length > 0) throw new Error(errors.join("; "));
    if (seenPaths.has(descriptor.path)) throw new Error(`Duplicate artifact path: ${descriptor.path}`);
    seenPaths.add(descriptor.path);
  });

  const eventLog = input.event_log ?? null;
  if (eventLog !== null) {
    if (!hasExactlyKeys(eventLog, EVENT_LOG_KEYS)) {
      throw new Error("event_log must contain exactly path, event_count, and chain_head");
    }
    assertArtifactPath(eventLog.path);
    if (!seenPaths.has(eventLog.path)) throw new Error("event_log.path must reference a manifest artifact");
    if (!Number.isSafeInteger(eventLog.event_count) || eventLog.event_count < 0) {
      throw new Error("event_log.event_count must be a non-negative safe integer");
    }
    if (eventLog.event_count === 0 && eventLog.chain_head !== null) {
      throw new Error("An empty event log cannot have a chain head");
    }
    if (eventLog.event_count > 0) assertSha256(eventLog.chain_head, "event_log.chain_head");
  }

  const metadata = immutableJson(input.metadata ?? null);
  const withoutHash: Omit<RunManifest, "manifest_hash"> = {
    schema_version: 1,
    run_id: input.run_id,
    created_at: input.created_at,
    artifacts: Object.freeze(artifacts.map((artifact) => Object.freeze({ ...artifact }))),
    event_log: eventLog === null ? null : Object.freeze({ ...eventLog }),
    metadata,
  };
  const manifestHash = domainHash(MANIFEST_HASH_DOMAIN, manifestBody(withoutHash));
  return Object.freeze({ ...withoutHash, manifest_hash: manifestHash });
}

export function verifyRunManifest(manifest: RunManifest): ManifestVerification {
  const errors: string[] = [];
  let expectedHash: string | null = null;
  try {
    if (!manifest || typeof manifest !== "object") throw new Error("Manifest is missing");
    if (!hasExactlyKeys(manifest, MANIFEST_KEYS)) {
      errors.push("Manifest has missing or unsupported fields");
    }
    if (manifest.schema_version !== 1) errors.push("Manifest has an unsupported schema_version");
    assertNonEmptyString(manifest.run_id, "run_id", 256);
    assertTimestamp(manifest.created_at, "created_at");
    assertSha256(manifest.manifest_hash, "manifest_hash");
    if (!Array.isArray(manifest.artifacts)) throw new Error("artifacts must be an array");

    const seenPaths = new Set<string>();
    manifest.artifacts.forEach((descriptor, index) => {
      errors.push(...descriptorErrors(descriptor, index));
      if (seenPaths.has(descriptor.path)) errors.push(`Duplicate artifact path: ${descriptor.path}`);
      seenPaths.add(descriptor.path);
      if (index > 0 && manifest.artifacts[index - 1].path >= descriptor.path) {
        errors.push("Artifact descriptors are not in canonical path order");
      }
    });

    if (manifest.event_log !== null) {
      const eventLog = manifest.event_log;
      if (!eventLog || typeof eventLog !== "object" || Array.isArray(eventLog)) {
        throw new Error("event_log must be an object or null");
      }
      if (!hasExactlyKeys(eventLog, EVENT_LOG_KEYS)) {
        errors.push("event_log has missing or unsupported fields");
      }
      assertArtifactPath(eventLog.path);
      if (!seenPaths.has(eventLog.path)) errors.push("event_log.path does not reference an artifact");
      if (!Number.isSafeInteger(eventLog.event_count) || eventLog.event_count < 0) {
        errors.push("event_log.event_count is invalid");
      }
      if (eventLog.event_count === 0 && eventLog.chain_head !== null) {
        errors.push("An empty event log cannot have a chain head");
      }
      if (eventLog.event_count > 0) assertSha256(eventLog.chain_head, "event_log.chain_head");
    }
    immutableJson(manifest.metadata);

    expectedHash = domainHash(MANIFEST_HASH_DOMAIN, manifestBody(manifest));
    if (manifest.manifest_hash !== expectedHash) errors.push("manifest_hash mismatch");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Manifest is invalid");
  }

  return Object.freeze({
    valid: errors.length === 0,
    expected_manifest_hash: expectedHash,
    errors: Object.freeze(errors),
  });
}

export function verifyArtifactContent(
  descriptor: ArtifactDescriptor,
  content: string | Uint8Array
): Readonly<{ valid: boolean; byte_length_matches: boolean; sha256_matches: boolean }> {
  const errors = descriptorErrors(descriptor, 0);
  if (errors.length > 0) throw new Error(errors.join("; "));
  const bytes = toBytes(content);
  const byteLengthMatches = bytes.byteLength === descriptor.byte_length;
  const digestMatches = sha256Hex(bytes) === descriptor.sha256;
  return Object.freeze({
    valid: byteLengthMatches && digestMatches,
    byte_length_matches: byteLengthMatches,
    sha256_matches: digestMatches,
  });
}
