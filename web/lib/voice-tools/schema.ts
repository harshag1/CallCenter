import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import { createHash } from "node:crypto";

const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_SCHEMA_NODES = 2_048;
const MAX_SCHEMA_DEPTH = 16;
const MAX_SCHEMA_ENTRIES = 256;
const MAX_SCHEMA_BRANCHES = 16;
const MAX_VALUE_BYTES = 1024 * 1024;
const MAX_VALUE_NODES = 10_000;
const MAX_VALUE_DEPTH = 32;

// These keywords either depend on external/recursive schema authority, execute regular
// expressions in the gateway, or are not transported consistently by every realtime provider.
// Inline the constraint or enforce it inside the trusted tool implementation instead.
const NON_PORTABLE_SCHEMA_KEYWORDS = new Set([
  "$anchor",
  "$defs",
  "$dynamicAnchor",
  "$dynamicRef",
  "$id",
  "$recursiveAnchor",
  "$recursiveRef",
  "$ref",
  "$schema",
  "pattern",
  "patternProperties",
]);

function createSchemaCompiler(): Ajv2020 {
  return new Ajv2020({
    allErrors: false,
    coerceTypes: false,
    removeAdditional: false,
    strict: false,
    useDefaults: false,
    validateFormats: false,
    validateSchema: true,
    // Realtime-provider schemas may carry these portable annotations. They remain
    // annotations (format validation is deliberately disabled), but registering
    // them keeps Ajv from emitting noisy unknown-format warnings during builds.
    formats: {
      uri: true,
      uuid: true,
    },
    // A compiler is scoped to one admitted schema. Ajv otherwise retains every
    // tenant-provided schema in its own internal cache even after our bounded
    // validator caches evict the corresponding function.
    addUsedSchema: false,
  });
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function plainJsonEntries(value: object): Readonly<{
  array: boolean;
  entries: readonly (readonly [string, unknown])[];
}> | null {
  try {
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      return null;
    }
    if (Object.getOwnPropertySymbols(value).length > 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (array) {
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0) return null;
      const keys = Object.keys(descriptors).filter((key) => key !== "length");
      if (keys.length !== length) return null; // Reject sparse arrays and extra properties.
      const entries: (readonly [string, unknown])[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) return null;
        entries.push([String(index), descriptor.value]);
      }
      return { array: true, entries };
    }
    const entries: (readonly [string, unknown])[] = [];
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor) || descriptor.enumerable !== true) return null;
      entries.push([key, descriptor.value]);
    }
    return { array: false, entries };
  } catch {
    // Hostile proxies/accessors are not JSON authority.
    return null;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("tool schema must contain finite JSON numbers");
    return JSON.stringify(value);
  }
  if (!value || typeof value !== "object") throw new Error("tool schema must be JSON-serializable");
  const inspected = plainJsonEntries(value);
  if (!inspected) throw new Error("tool schema must contain plain data properties");
  if (inspected.array) return `[${inspected.entries.map(([, item]) => canonicalJson(item)).join(",")}]`;
  const entries = [...inspected.entries]
    .sort(([left], [right]) => compareCodeUnits(left, right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/**
 * Returns a detached, frozen JSON Schema that is safe to pin and transport through the common
 * OpenAI/xAI/Gemini function-tool boundary. Tool arguments always use an object at the root.
 */
export function normalizeVoiceToolSchema(
  input: unknown,
  options: { label?: string; requireObjectRoot?: boolean } = {}
): Readonly<Record<string, unknown>> {
  const label = options.label ?? "tool schema";
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be a JSON Schema object`);
  }
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_SCHEMA_NODES || depth > MAX_SCHEMA_DEPTH) {
      throw new Error(`${label} exceeds the portable complexity limit`);
    }
    if (value === null || typeof value === "boolean" || typeof value === "string") return;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
      return;
    }
    if (!value || typeof value !== "object" || seen.has(value)) {
      throw new Error(`${label} must be acyclic JSON`);
    }
    const inspected = plainJsonEntries(value);
    if (!inspected) throw new Error(`${label} must contain plain JSON data properties`);
    seen.add(value);
    if (inspected.array) {
      if (inspected.entries.length > MAX_SCHEMA_ENTRIES) throw new Error(`${label} contains an oversized array`);
      for (const [, item] of inspected.entries) visit(item, depth + 1);
      seen.delete(value);
      return;
    }
    const entries = inspected.entries;
    if (entries.length > MAX_SCHEMA_ENTRIES) throw new Error(`${label} contains too many properties`);
    for (const [key, item] of entries) {
      if (NON_PORTABLE_SCHEMA_KEYWORDS.has(key)) {
        throw new Error(`${label} uses non-portable keyword "${key}"`);
      }
      if (["allOf", "anyOf", "oneOf"].includes(key) &&
          (!Array.isArray(item) || item.length > MAX_SCHEMA_BRANCHES)) {
        throw new Error(`${label} contains an oversized schema branch`);
      }
      visit(item, depth + 1);
    }
    seen.delete(value);
  };
  visit(input, 0);

  const encoded = canonicalJson(input);
  if (Buffer.byteLength(encoded, "utf8") > MAX_SCHEMA_BYTES) {
    throw new Error(`${label} exceeds 64KB`);
  }
  const normalized = JSON.parse(encoded) as Record<string, unknown>;
  if ((options.requireObjectRoot ?? true) && normalized.type !== "object") {
    throw new Error(`${label} must declare type "object" at the root`);
  }
  try {
    const compiler = createSchemaCompiler();
    if (!compiler.validateSchema(normalized)) throw new Error("invalid");
    compiler.compile(normalized);
  } catch {
    throw new Error(`${label} is not valid portable JSON Schema`);
  }
  return deepFreeze(normalized);
}

export function compileVoiceToolSchema(
  schema: Readonly<Record<string, unknown>>
): ValidateFunction {
  try {
    return createSchemaCompiler().compile(schema);
  } catch {
    throw new Error("voice tool schema could not be compiled");
  }
}

/** Bounds provider/model-controlled arguments and integration-controlled outputs before AJV. */
export function isBoundedVoiceToolJson(value: unknown): boolean {
  let nodes = 0;
  let bytes = 0;
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > MAX_VALUE_NODES || depth > MAX_VALUE_DEPTH) return false;
    if (item === null || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item === "string") {
      bytes += Buffer.byteLength(item, "utf8");
      return bytes <= MAX_VALUE_BYTES;
    }
    if (!item || typeof item !== "object" || seen.has(item)) return false;
    const inspected = plainJsonEntries(item);
    if (!inspected) return false;
    seen.add(item);
    const entries = inspected.entries;
    if (entries.length > 4_096) return false;
    for (const [key, entry] of entries) {
      bytes += Buffer.byteLength(key, "utf8");
      if (bytes > MAX_VALUE_BYTES || !visit(entry, depth + 1)) return false;
    }
    seen.delete(item);
    return true;
  };
  try {
    if (!visit(value, 0)) return false;
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_VALUE_BYTES;
  } catch {
    return false;
  }
}

export type DetachedVoiceToolJson =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false }>;

/** Validates and snapshots plain JSON so later caller/integration mutation cannot change authority. */
export function detachBoundedVoiceToolJson(value: unknown): DetachedVoiceToolJson {
  if (!isBoundedVoiceToolJson(value)) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(canonicalJson(value)) as unknown };
  } catch {
    return { ok: false };
  }
}

export function voiceToolDefinitionDigest(definition: {
  name: string;
  description: string;
  implementationDigest: string;
  inputSchema: Readonly<Record<string, unknown>>;
  outputSchema?: Readonly<Record<string, unknown>>;
  effect?: "read" | "write" | "opaque";
  reconciliation?: unknown;
}): string {
  const semanticDefinition = {
    name: definition.name,
    description: definition.description,
    implementationDigest: definition.implementationDigest,
    inputSchema: definition.inputSchema,
    ...(definition.outputSchema !== undefined ? { outputSchema: definition.outputSchema } : {}),
    ...(definition.effect !== undefined ? { effect: definition.effect } : {}),
    ...(definition.reconciliation !== undefined ? { reconciliation: definition.reconciliation } : {}),
  };
  return createHash("sha256")
    .update("hacc/voice-tool-definition/v1\0", "utf8")
    .update(canonicalJson(semanticDefinition), "utf8")
    .digest("hex");
}

/** Binds one complete admitted extension catalog to the immutable call admission identity. */
export function voiceToolAdmissionScopeDigest(
  scope: Readonly<{ callId: string; agentId: string; orgId: string }>,
  catalog: readonly Readonly<{ name: string; definitionDigest: string }>[]
): string {
  for (const value of [scope.callId, scope.agentId, scope.orgId]) {
    if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > 4 * 1024) {
      throw new Error("invalid voice tool admission scope");
    }
  }
  if (!Array.isArray(catalog) || catalog.length > 256) {
    throw new Error("invalid voice tool admission catalog");
  }
  const normalized = catalog.map((entry) => {
    if (!entry || typeof entry !== "object" ||
        typeof entry.name !== "string" || !entry.name ||
        !/^[a-f0-9]{64}$/.test(entry.definitionDigest)) {
      throw new Error("invalid voice tool admission catalog entry");
    }
    return { name: entry.name, definitionDigest: entry.definitionDigest };
  }).sort((left, right) => compareCodeUnits(left.name, right.name));
  if (new Set(normalized.map((entry) => entry.name)).size !== normalized.length) {
    throw new Error("duplicate voice tool admission catalog entry");
  }
  return createHash("sha256")
    .update("hacc/voice-tool-admission-scope/v1\0", "utf8")
    .update(canonicalJson({
      scope: { callId: scope.callId, agentId: scope.agentId, orgId: scope.orgId },
      catalog: normalized,
    }), "utf8")
    .digest("hex");
}

export function voiceToolImplementationDigest(extension: {
  execute: unknown;
  isAvailable?: unknown;
  implementationRevision?: unknown;
}): string {
  if (typeof extension.execute !== "function" ||
      (extension.isAvailable !== undefined && typeof extension.isAvailable !== "function")) {
    throw new Error("voice tool implementation must be callable");
  }
  if (
    extension.implementationRevision !== undefined
    && (
      typeof extension.implementationRevision !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._+@:/-]{0,511}$/.test(extension.implementationRevision)
    )
  ) throw new Error("voice tool implementation revision is invalid");
  return createHash("sha256")
    .update("hacc/voice-tool-implementation/v1\0", "utf8")
    .update(typeof extension.implementationRevision === "string"
      ? extension.implementationRevision
      : "unversioned", "utf8")
    .update("\0", "utf8")
    .update(Function.prototype.toString.call(extension.execute), "utf8")
    .update("\0", "utf8")
    .update(typeof extension.isAvailable === "function"
      ? Function.prototype.toString.call(extension.isAvailable)
      : "", "utf8")
    .digest("hex");
}
