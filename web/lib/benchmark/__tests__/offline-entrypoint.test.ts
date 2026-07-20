import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const tsx = resolve(process.cwd(), "node_modules/.bin/tsx");

describe("provider-incapable offline benchmark entrypoint", () => {
  it("has no paid runner, provider client, or socket package in its runtime import closure", async () => {
    const result = await execFileAsync(tsx, ["scripts/check-offline-benchmark-imports.ts"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(report).toMatchObject({
      schema_version: 1,
      entry: "scripts/voice-benchmark-offline.ts",
      provider_client_construction_reachable: false,
      external_socket_imports: [],
      forbidden_runtime_inputs: [],
    });
    expect(report.runtime_input_count).toBeGreaterThan(0);
    expect(report.runtime_import_closure_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails run paid closed before any executor can exist", async () => {
    await expect(execFileAsync(tsx, ["scripts/voice-benchmark-offline.ts", "run", "paid", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { NODE_ENV: "test", PATH: dirname(process.execPath) },
    })).rejects.toMatchObject({
      code: 3,
      stderr: expect.stringContaining('"code":"paid_executor_unavailable"'),
    });
  }, 30_000);
});
