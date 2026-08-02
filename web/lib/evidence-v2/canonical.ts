import { createHash } from "node:crypto";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

function normalize(value: unknown, path: string, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`);
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error(`${path} contains an integer outside JSON-safe precision`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") throw new Error(`${path} is not JSON-serializable`);
  if (ancestors.has(value)) throw new Error(`${path} contains a cycle`);

  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} must contain only plain JSON objects`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new Error(`${path}[${index}] is a sparse array entry`);
        }
        return normalize(item, `${path}[${index}]`, ancestors);
      });
    }
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      output[key] = normalize((value as Record<string, unknown>)[key], `${path}.${key}`, ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function freeze<T extends JsonValue>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Array.isArray(value) ? value : Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

export function immutableJson(value: unknown): JsonValue {
  return freeze(normalize(value, "$", new Set()));
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, "$", new Set()));
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
