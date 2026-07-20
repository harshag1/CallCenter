import { createHash, timingSafeEqual } from "node:crypto";

const MINIMUM_CRON_SECRET_BYTES = 32;
const MAXIMUM_BEARER_BYTES = 4_096;
const OPAQUE_BEARER = /^[A-Za-z0-9._~+/=-]+$/;

function configuredCronSecret(value: string | undefined): string | null {
  if (
    typeof value !== "string"
    || value.length < MINIMUM_CRON_SECRET_BYTES
    || value.length > MAXIMUM_BEARER_BYTES
    || value !== value.trim()
    || !OPAQUE_BEARER.test(value)
    || value === "undefined"
    || value === "null"
  ) {
    return null;
  }
  return value;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Fail-closed cron bearer authentication. Missing or weak configuration can
 * never synthesize an accepted header such as the historical
 * `Bearer undefined` case.
 */
export function authorizeCronRequest(
  authorizationHeader: string | null,
  configuredSecret: string | undefined
): boolean {
  const secret = configuredCronSecret(configuredSecret);
  if (!secret || !authorizationHeader || authorizationHeader.length > MAXIMUM_BEARER_BYTES + 7) {
    return false;
  }
  const match = /^Bearer ([^\s,]+)$/.exec(authorizationHeader);
  if (!match || !OPAQUE_BEARER.test(match[1])) return false;
  return timingSafeEqual(digest(match[1]), digest(secret));
}

export const CRON_SECRET_MINIMUM_BYTES = MINIMUM_CRON_SECRET_BYTES;
