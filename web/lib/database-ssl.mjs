const DATABASE_PROTOCOLS = new Set(["postgres:", "postgresql:"]);
const DATABASE_TLS_QUERY_KEYS = Object.freeze([
  "sslmode",
  "ssl",
  "sslcert",
  "sslkey",
  "sslrootcert",
]);

function isLoopbackDatabaseHost(hostname) {
  const value = hostname.toLowerCase();
  return value === "localhost"
    || value === "127.0.0.1"
    || value === "[::1]"
    || value === "::1";
}

/**
 * Resolve the only two supported database transport policies. Plaintext is a
 * local-development exception, never a production or remote-host default.
 *
 * @param {{
 *   connectionString: string;
 *   configuredMode?: string;
 *   nodeEnv?: string;
 * }} input
 * @returns {"disable" | "verify-full"}
 */
export function resolveDatabaseSslMode(input) {
  if (!input || typeof input !== "object"
      || typeof input.connectionString !== "string"
      || input.connectionString.length === 0
      || input.connectionString.length > 16_384) {
    throw new Error("database connection string is invalid");
  }
  let parsed;
  try {
    parsed = new URL(input.connectionString);
  } catch {
    throw new Error("database connection string must be an absolute PostgreSQL URL");
  }
  if (!DATABASE_PROTOCOLS.has(parsed.protocol) || !parsed.hostname) {
    throw new Error("database connection string must be an absolute PostgreSQL URL");
  }
  if (DATABASE_TLS_QUERY_KEYS.some((key) => parsed.searchParams.has(key))) {
    throw new Error("database TLS policy must use DATABASE_SSL, not connection-string TLS parameters");
  }

  const configured = input.configuredMode;
  if (configured !== undefined && configured !== "disable" && configured !== "verify-full") {
    throw new Error("DATABASE_SSL must be either verify-full or disable");
  }
  const production = input.nodeEnv === "production";
  const loopback = isLoopbackDatabaseHost(parsed.hostname);
  const mode = configured ?? (!production && loopback ? "disable" : "verify-full");
  if (mode === "disable" && (production || !loopback)) {
    throw new Error("DATABASE_SSL=disable is allowed only for non-production loopback databases");
  }
  return mode;
}
