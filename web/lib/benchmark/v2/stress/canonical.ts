import { createHash } from "node:crypto";

export function canonicalStressJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical stress JSON rejects non-finite numbers");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalStressJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => {
      if (record[key] === undefined) throw new Error("canonical stress JSON rejects undefined");
      return `${JSON.stringify(key)}:${canonicalStressJson(record[key])}`;
    }).join(",")}}`;
  }
  throw new Error(`canonical stress JSON rejects ${typeof value}`);
}
export function stressSha256(domain: string, value: unknown): string {
  return createHash("sha256").update(`${domain}\n${canonicalStressJson(value)}`, "utf8").digest("hex");
}

export function serializeOfflineStressReport(value: unknown): string {
  return `${canonicalStressJson(value)}\n`;
}
