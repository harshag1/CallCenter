import { describe, expect, it } from "vitest";
import { resolveDatabaseSslMode } from "../database-ssl.mjs";

describe("database TLS policy", () => {
  it("defaults every production database to verified TLS", () => {
    expect(resolveDatabaseSslMode({
      connectionString: "postgresql://user:pass@db.example.test/app",
      nodeEnv: "production",
    })).toBe("verify-full");
  });

  it.each([
    "postgresql://user:pass@db.example.test/app",
    "postgresql://user:pass@10.0.0.8/app",
  ])("rejects plaintext to non-loopback host %s", (connectionString) => {
    expect(() => resolveDatabaseSslMode({
      connectionString,
      configuredMode: "disable",
      nodeEnv: "development",
    })).toThrow("non-production loopback");
  });

  it("rejects plaintext in production even for loopback", () => {
    expect(() => resolveDatabaseSslMode({
      connectionString: "postgresql://user:pass@localhost/app",
      configuredMode: "disable",
      nodeEnv: "production",
    })).toThrow("non-production loopback");
  });

  it.each([
    "postgresql://user:pass@localhost/app",
    "postgresql://user:pass@127.0.0.1/app",
    "postgresql://user:pass@[::1]/app",
  ])("allows the explicit local-development exception for %s", (connectionString) => {
    expect(resolveDatabaseSslMode({
      connectionString,
      configuredMode: "disable",
      nodeEnv: "development",
    })).toBe("disable");
  });

  it("defaults local development to plaintext and remote development to verified TLS", () => {
    expect(resolveDatabaseSslMode({
      connectionString: "postgresql://user:pass@localhost/app",
      nodeEnv: "development",
    })).toBe("disable");
    expect(resolveDatabaseSslMode({
      connectionString: "postgresql://user:pass@db.example.test/app",
      nodeEnv: "development",
    })).toBe("verify-full");
  });

  it.each([
    "postgresql://user:pass@db.example.test/app?sslmode=disable",
    "postgresql://user:pass@db.example.test/app?sslmode=require",
    "postgresql://user:pass@db.example.test/app?sslrootcert=%2Ftmp%2Fca.pem",
  ])("rejects connection-string TLS overrides: %s", (connectionString) => {
    expect(() => resolveDatabaseSslMode({
      connectionString,
      nodeEnv: "production",
    })).toThrow("DATABASE_SSL");
  });

  it("rejects ambiguous configured modes", () => {
    expect(() => resolveDatabaseSslMode({
      connectionString: "postgresql://user:pass@db.example.test/app",
      configuredMode: "require",
      nodeEnv: "production",
    })).toThrow("verify-full or disable");
  });
});
