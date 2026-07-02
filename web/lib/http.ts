// Author: Harsha Gundala
// http.ts — tiny request-hygiene helpers shared by API routes.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when the value is a canonical UUID — guards pg "invalid input syntax" 500s. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Body parse that never throws: malformed JSON becomes null so routes can 400. */
export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T | null> {
  try {
    const body = (await req.json()) as T;
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}
