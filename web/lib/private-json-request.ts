// Strict same-origin JSON boundary for browser-only authority mutations.

import { requirePublicOrigin } from "./public-origin";

export const PRIVATE_NO_STORE_HEADERS = Object.freeze({
  "Cache-Control": "private, no-store, max-age=0",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Pragma": "no-cache",
  "Expires": "0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Vary": "Origin, Sec-Fetch-Site",
});

export class PrivateRequestError extends Error {
  constructor(readonly status: 400 | 403 | 413 | 415) {
    super("invalid private browser request");
    this.name = "PrivateRequestError";
  }
}

function hasExactJsonContentType(request: Request): boolean {
  const raw = request.headers.get("content-type");
  if (!raw || raw.length > 256 || raw.includes(",")) return false;
  const parts = raw.split(";").map((part) => part.trim());
  if (parts[0]?.toLowerCase() !== "application/json") return false;
  if (parts.length === 1) return true;
  return parts.length === 2
    && /^charset\s*=\s*(?:utf-8|"utf-8")$/i.test(parts[1]);
}

function requireBoundedSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 256 * 1024 * 1024) {
    throw new Error("private request size limit is invalid");
  }
  return value;
}

function validateDeclaredLength(request: Request, maxBytes: number): void {
  const declared = request.headers.get("content-length");
  if (declared === null) return;
  if (!/^\d+$/.test(declared)) throw new PrivateRequestError(400);
  try {
    if (BigInt(declared) > BigInt(maxBytes)) throw new PrivateRequestError(413);
  } catch (error) {
    if (error instanceof PrivateRequestError) throw error;
    throw new PrivateRequestError(400);
  }
}

async function readBoundedPrivateBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  requireBoundedSize(maxBytes);
  validateDeclaredLength(request, maxBytes);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let chunkCount = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    chunkCount += 1;
    if (bytes > maxBytes || chunkCount > 8_192) {
      await reader.cancel().catch(() => {});
      throw new PrivateRequestError(413);
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

export function assertSameOriginBrowserMutation(request: Request): void {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (!origin || origin === "null" || fetchSite !== "same-origin") {
    throw new PrivateRequestError(403);
  }
  try {
    const parsed = new URL(origin);
    if (parsed.username || parsed.password || parsed.origin !== requirePublicOrigin()) {
      throw new PrivateRequestError(403);
    }
  } catch (error) {
    if (error instanceof PrivateRequestError) throw error;
    throw new PrivateRequestError(403);
  }
}

/**
 * JSON.parse silently keeps the last occurrence of a duplicate object key.
 * Authority-bearing request bodies reject that ambiguity at every nesting
 * level, including keys that become equal only after JSON escape decoding.
 */
function assertNoDuplicateJsonObjectKeys(text: string): void {
  let offset = 0;
  const fail = (): never => { throw new PrivateRequestError(400); };
  const skipWhitespace = () => {
    while (offset < text.length && /[\u0009\u000a\u000d\u0020]/.test(text[offset])) offset += 1;
  };
  const readString = (decode: boolean): string => {
    if (text[offset] !== '"') return fail();
    const start = offset;
    offset += 1;
    while (offset < text.length) {
      if (text[offset] === '"') {
        offset += 1;
        if (!decode) return "";
        try {
          return JSON.parse(text.slice(start, offset)) as string;
        } catch {
          return fail();
        }
      }
      if (text[offset] === "\\") {
        offset += 1;
        if (offset >= text.length) return fail();
      }
      offset += 1;
    }
    return fail();
  };
  const readValue = (depth: number): void => {
    if (depth > 64) return fail();
    skipWhitespace();
    if (offset >= text.length) return fail();
    if (text[offset] === '"') {
      readString(false);
      return;
    }
    if (text[offset] === "{") {
      offset += 1;
      skipWhitespace();
      if (text[offset] === "}") {
        offset += 1;
        return;
      }
      const keys = new Set<string>();
      while (offset < text.length) {
        skipWhitespace();
        const key = readString(true);
        if (keys.has(key)) return fail();
        keys.add(key);
        skipWhitespace();
        if (text[offset] !== ":") return fail();
        offset += 1;
        readValue(depth + 1);
        skipWhitespace();
        if (text[offset] === "}") {
          offset += 1;
          return;
        }
        if (text[offset] !== ",") return fail();
        offset += 1;
      }
      return fail();
    }
    if (text[offset] === "[") {
      offset += 1;
      skipWhitespace();
      if (text[offset] === "]") {
        offset += 1;
        return;
      }
      while (offset < text.length) {
        readValue(depth + 1);
        skipWhitespace();
        if (text[offset] === "]") {
          offset += 1;
          return;
        }
        if (text[offset] !== ",") return fail();
        offset += 1;
      }
      return fail();
    }
    const start = offset;
    while (
      offset < text.length
      && !/[\u0009\u000a\u000d\u0020,\]}]/.test(text[offset])
    ) offset += 1;
    if (offset === start) return fail();
  };

  readValue(0);
  skipWhitespace();
  if (offset !== text.length) fail();
}

/** Strict bounded JSON object reader for both browser and authenticated machine ingress. */
export async function readStrictJsonObject(
  request: Request,
  maxBytes = 4 * 1024
): Promise<Record<string, unknown>> {
  requireBoundedSize(maxBytes);
  // The Headers API comma-folds duplicate Content-Type fields. Reject every
  // comma and unknown parameter so an authority route, proxy, and WAF cannot
  // disagree about which representation was submitted.
  if (!hasExactJsonContentType(request)) throw new PrivateRequestError(415);
  const joined = await readBoundedPrivateBody(request, maxBytes);
  if (joined.byteLength === 0) throw new PrivateRequestError(400);
  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(joined);
    assertNoDuplicateJsonObjectKeys(text);
    parsed = JSON.parse(text);
  } catch (error) {
    if (error instanceof PrivateRequestError) throw error;
    throw new PrivateRequestError(400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PrivateRequestError(400);
  }
  return parsed as Record<string, unknown>;
}

/** Browser-mutation compatibility name; pair with assertSameOriginBrowserMutation. */
export async function readPrivateJsonObject(
  request: Request,
  maxBytes = 4 * 1024,
): Promise<Record<string, unknown>> {
  return readStrictJsonObject(request, maxBytes);
}

/** Strict, bounded multipart parsing for browser-only file mutations. */
export async function readPrivateFormData(
  request: Request,
  maxBytes: number,
): Promise<FormData> {
  requireBoundedSize(maxBytes);
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(contentType) || !/;\s*boundary=(?:"[^"]+"|[^;\s]+)/i.test(contentType)) {
    throw new PrivateRequestError(415);
  }
  const bytes = await readBoundedPrivateBody(request, maxBytes);
  if (bytes.byteLength === 0) throw new PrivateRequestError(400);
  try {
    const owned = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(owned).set(bytes);
    return await new Response(owned, { headers: { "Content-Type": contentType } }).formData();
  } catch {
    throw new PrivateRequestError(400);
  }
}

/** No-body mutations reject smuggled or accidental content before authentication. */
export async function assertEmptyPrivateRequest(request: Request): Promise<void> {
  const declared = request.headers.get("content-length");
  if (declared !== null && declared !== "0") {
    if (!/^\d+$/.test(declared)) throw new PrivateRequestError(400);
    throw new PrivateRequestError(413);
  }
  if (!request.body) return;
  const bytes = await readBoundedPrivateBody(request, 1);
  if (bytes.byteLength !== 0) throw new PrivateRequestError(413);
}
