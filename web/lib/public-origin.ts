// Canonical external authority for provider callbacks and server-issued URLs.

function isLoopback(hostname: string): boolean {
  const value = hostname.toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "[::1]" || value === "::1";
}

export function requirePublicOrigin(): string {
  const configured = process.env.PUBLIC_ORIGIN;
  if (!configured || configured.length > 2_048 || configured.trim() !== configured) {
    throw new Error("PUBLIC_ORIGIN is required");
  }
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("PUBLIC_ORIGIN must be an absolute URL");
  }
  const localDevelopment = process.env.NODE_ENV !== "production" && parsed.protocol === "http:" && isLoopback(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !localDevelopment) ||
    !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    throw new Error("PUBLIC_ORIGIN must be a credential-free HTTPS origin (HTTP loopback is development-only)");
  }
  return parsed.origin;
}
