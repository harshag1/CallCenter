import { createHash } from "node:crypto";

/**
 * Canonical JSON used by production runtime-control commitments.
 *
 * This intentionally accepts only inert JSON data. Accessors, custom
 * prototypes, sparse arrays, cycles, undefined, and non-finite numbers are
 * rejected so hashing cannot execute application code or silently omit data.
 */
export function canonicalRuntimeControlJson(value: unknown): string {
  const ancestors = new Set<object>();

  const encode = (current: unknown): string => {
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      return JSON.stringify(current);
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new TypeError("canonical runtime-control JSON rejects non-finite numbers");
      return JSON.stringify(Object.is(current, -0) ? 0 : current);
    }
    if (typeof current !== "object") {
      throw new TypeError(`canonical runtime-control JSON rejects ${typeof current}`);
    }
    if (ancestors.has(current)) throw new TypeError("canonical runtime-control JSON rejects cycles");

    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        const values: string[] = [];
        for (let index = 0; index < current.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(current, index)) {
            throw new TypeError("canonical runtime-control JSON rejects sparse arrays");
          }
          values.push(encode(current[index]));
        }
        return `[${values.join(",")}]`;
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("canonical runtime-control JSON rejects custom prototypes");
      }
      const record = current as Record<string, unknown>;
      const keys = Object.keys(record).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
      const properties: string[] = [];
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (!descriptor || !("value" in descriptor)) {
          throw new TypeError("canonical runtime-control JSON rejects accessors");
        }
        properties.push(`${JSON.stringify(key)}:${encode(descriptor.value)}`);
      }
      return `{${properties.join(",")}}`;
    } finally {
      ancestors.delete(current);
    }
  };

  return encode(value);
}

export function runtimeControlSha256(domain: string, value: string | Uint8Array): string {
  return createHash("sha256")
    .update(domain, "utf8")
    .update(value)
    .digest("hex");
}

export function immutableRuntimeControlValue<T>(value: T): T {
  const cloned = structuredClone(value);
  const freeze = (current: unknown): void => {
    if (current === null || typeof current !== "object" || Object.isFrozen(current)) return;
    Object.freeze(current);
    for (const child of Object.values(current)) freeze(child);
  };
  freeze(cloned);
  return cloned;
}
