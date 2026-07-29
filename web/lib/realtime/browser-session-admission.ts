import "server-only";

import { browserFundingAuthorityKind } from "./browser-funding-authority";
import type { VoiceProviderId } from "./types";

function isExactLocalDevelopmentLoopback(hostname: string): boolean {
  const value = hostname.toLowerCase();
  return value === "localhost"
    || value === "127.0.0.1"
    || value === "[::1]"
    || value === "::1";
}

function withoutIpv6Brackets(hostname: string): string {
  const value = hostname.toLowerCase();
  return value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
}

function isIpv4Loopback(hostname: string): boolean {
  const octets = hostname.split(".");
  return octets.length === 4
    && octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet))
    && octets.every((octet) => Number(octet) <= 255)
    && Number(octets[0]) === 127;
}

/**
 * WHATWG URL parsing canonicalizes IPv4-mapped literals such as
 * `::ffff:127.0.0.1` to `::ffff:7f00:1`. Treat the complete mapped 127/8
 * range—and the legacy IPv4-compatible spelling—as loopback too.
 */
function isIpv4EmbeddedLoopback(hostname: string): boolean {
  const match = /^(?:::ffff:|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(
    withoutIpv6Brackets(hostname),
  );
  if (!match) return false;
  const high = Number.parseInt(match[1], 16);
  return (high >>> 8) === 127;
}

function isAnyLoopback(hostname: string): boolean {
  const value = withoutIpv6Brackets(hostname);
  return value === "::1"
    || value === "localhost"
    || value.endsWith(".localhost")
    || value === "localhost."
    || value.endsWith(".localhost.")
    || isIpv4Loopback(value)
    || isIpv4EmbeddedLoopback(value);
}

function canonicalOrigin(value: string): URL | null {
  try {
    const parsed = new URL(value);
    return parsed.origin === value ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Bind browser transport availability to the same funding capability that
 * reaches the token mint. Tenant BYOK uses a canonical non-loopback HTTPS
 * origin; deployment-key authority is valid only on non-production HTTP
 * loopback.
 */
export function assertBrowserVoiceSessionAdmission(input: Readonly<{
  provider: VoiceProviderId;
  origin: string;
  fundingAuthority: unknown;
}>): void {
  const kind = browserFundingAuthorityKind(
    input.fundingAuthority,
    input.provider,
  );
  if (!kind) {
    throw new Error("browser voice session requires valid provider funding authority");
  }
  const origin = canonicalOrigin(input.origin);
  const exactLocalLoopback = origin
    ? isExactLocalDevelopmentLoopback(origin.hostname)
    : false;
  if (kind === "local_deployment_authorized") {
    if (
      process.env.NODE_ENV === "production"
      || !origin
      || origin.protocol !== "http:"
      || !exactLocalLoopback
    ) {
      throw new Error(
        "local browser voice sessions require non-production plain-HTTP loopback PUBLIC_ORIGIN",
      );
    }
    return;
  }
  if (
    !origin
    || origin.protocol !== "https:"
    || isAnyLoopback(origin.hostname)
  ) {
    throw new Error(
      "tenant BYOK browser voice sessions require a canonical non-loopback HTTPS PUBLIC_ORIGIN",
    );
  }
}
