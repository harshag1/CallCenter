import { describe, expect, it } from "vitest";

import { runLc4QualificationV4OperatorCli } from "../lc4-qualification-v4-operator-cli";

describe("LC4 qualification v4 operator", () => {
  it("exposes the exact non-default serial resume contract without provider access", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runLc4QualificationV4OperatorCli(["status"], {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      now: () => new Date("2026-08-01T16:00:00.000Z"),
    });
    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join(""))).toEqual({
      admitted_without_terminal: "quarantine_no_retry",
      default: false,
      maximum_total_usd: 3,
      operator: "HACC-LC4-QUALIFICATION-V4-OPERATOR-v1",
      paid_retries: 0,
      provider_order: ["openai", "gemini", "xai"],
      resumable_boundaries: ["unopened_provider_shard", "retained_setup_before_paid_admission"],
    });
  });

  it("fails closed before credentials or providers when continue flags are incomplete", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runLc4QualificationV4OperatorCli(["continue", "--root", "/tmp/example"], {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      now: () => new Date("2026-08-01T16:00:00.000Z"),
    });
    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(JSON.parse(stderr.join(""))).toMatchObject({
      error: "lc4_qualification_v4_operator_refused",
      provider_calls_retried: 0,
    });
  });
});
