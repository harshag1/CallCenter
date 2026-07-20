import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadDatabaseConnectionConfig,
  resolveDatabaseConnectionConfig,
} from "../database-connection";

describe("database connection configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses stock DATABASE_URL with the explicit local-development TLS exception", () => {
    expect(resolveDatabaseConnectionConfig({
      databaseUrl: "postgresql://user:pass@localhost/app",
      configuredMode: "disable",
      nodeEnv: "development",
    })).toEqual({
      connectionString: "postgresql://user:pass@localhost/app",
      ssl: false,
    });
  });

  it("uses the platform trust store for a verified stock DATABASE_URL", () => {
    expect(resolveDatabaseConnectionConfig({
      databaseUrl: "postgresql://user:pass@db.example.test/app",
      configuredMode: "verify-full",
      defaultSupabaseCaCert: "must-not-pin-a-stock-database",
      nodeEnv: "production",
    })).toEqual({
      connectionString: "postgresql://user:pass@db.example.test/app",
      ssl: { rejectUnauthorized: true },
    });
  });

  it("supports an explicit custom CA for DATABASE_URL", () => {
    expect(resolveDatabaseConnectionConfig({
      databaseUrl: "postgresql://user:pass@db.example.test/app",
      configuredMode: "verify-full",
      databaseCaCert: "line-one\\nline-two",
      nodeEnv: "production",
    })).toEqual({
      connectionString: "postgresql://user:pass@db.example.test/app",
      ssl: {
        rejectUnauthorized: true,
        ca: "line-one\nline-two",
      },
    });
  });

  it("keeps SUPABASE_DB_URL and its bundled CA fallback supported", () => {
    expect(resolveDatabaseConnectionConfig({
      supabaseDatabaseUrl: "postgresql://user:pass@db.supabase.example/app",
      configuredMode: "verify-full",
      defaultSupabaseCaCert: "supabase-ca",
      nodeEnv: "production",
    })).toEqual({
      connectionString: "postgresql://user:pass@db.supabase.example/app",
      ssl: {
        rejectUnauthorized: true,
        ca: "supabase-ca",
      },
    });
  });

  it("gives DATABASE_URL deterministic precedence without falling through an invalid value", () => {
    expect(() => resolveDatabaseConnectionConfig({
      databaseUrl: "",
      supabaseDatabaseUrl: "postgresql://user:pass@db.supabase.example/app",
      configuredMode: "verify-full",
      nodeEnv: "production",
    })).toThrow("DATABASE_URL or SUPABASE_DB_URL is required");
  });

  it("fails closed for remote plaintext and connection-string TLS overrides", () => {
    expect(() => resolveDatabaseConnectionConfig({
      databaseUrl: "postgresql://user:pass@db.example.test/app",
      configuredMode: "disable",
      nodeEnv: "development",
    })).toThrow("non-production loopback");
    expect(() => resolveDatabaseConnectionConfig({
      databaseUrl: "postgresql://user:pass@db.example.test/app?sslmode=disable",
      configuredMode: "verify-full",
      nodeEnv: "production",
    })).toThrow("DATABASE_SSL");
  });

  it("loads the bundled CA only for the Supabase-specific environment fallback", () => {
    const standard = loadDatabaseConnectionConfig({
      DATABASE_URL: "postgresql://user:pass@db.example.test/app",
      DATABASE_SSL: "verify-full",
      NODE_ENV: "production",
    }, process.cwd());
    expect(standard.ssl).toEqual({ rejectUnauthorized: true });

    const supabase = loadDatabaseConnectionConfig({
      SUPABASE_DB_URL: "postgresql://user:pass@db.supabase.example/app",
      DATABASE_SSL: "verify-full",
      NODE_ENV: "production",
    }, process.cwd());
    expect(supabase.ssl).toMatchObject({
      rejectUnauthorized: true,
      ca: expect.stringContaining("BEGIN CERTIFICATE"),
    });
  });
});
