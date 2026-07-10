import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export function loadProjectEnv(webDir) {
  const path = `${webDir}/.env.local`;
  const file = existsSync(path)
    ? Object.fromEntries(
        readFileSync(path, "utf8")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith("#") && line.includes("="))
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)])
      )
    : {};
  return { ...file, ...process.env };
}

export function databaseConfig(env, webDir) {
  const connectionString = env.DATABASE_URL ?? env.SUPABASE_DB_URL;
  if (!connectionString) throw new Error("DATABASE_URL or SUPABASE_DB_URL is required");
  const sslMode = env.DATABASE_SSL ?? (env.SUPABASE_DB_URL ? "verify-full" : "disable");
  const caPath = env.DATABASE_CA_PATH ?? `${webDir}/certs/supabase-ca.crt`;
  return {
    connectionString,
    ssl: sslMode === "disable"
      ? false
      : { rejectUnauthorized: true, ...(existsSync(caPath) ? { ca: readFileSync(caPath, "utf8") } : {}) },
  };
}

export function signScope(secret, payload, ttlSeconds = 2 * 60 * 60) {
  if (!secret || secret.length < 32) throw new Error("MCP_GATEWAY_SECRET must be at least 32 characters");
  const body = Buffer.from(JSON.stringify({
    ...payload,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    v: 1,
  })).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}
