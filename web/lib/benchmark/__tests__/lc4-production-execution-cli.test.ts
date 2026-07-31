import { describe, expect, it } from "vitest";
import { runLc4ProductionExecutionCli } from "../lc4-production-execution-cli";

function io() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    adapter: {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
      now: () => new Date("2026-07-21T20:10:00.000Z"),
    },
  };
}

describe("LC4 production execution CLI", () => {
  it("reports a source-frozen, cryptographically authorized boundary with no environment override", async () => {
    const output = io();
    await expect(runLc4ProductionExecutionCli(["status"], output.adapter)).resolves.toBe(0);
    expect(JSON.parse(output.stdout[0])).toMatchObject({
      paid_provider_execution_build_frozen: true,
      environment_override_supported: false,
      authorization_mechanism: "pinned-ed25519-artifact",
    });
    expect(output.stderr).toEqual([]);
  });

  it("fails closed on unknown commands and incomplete preflight inputs", async () => {
    const unknown = io();
    await expect(runLc4ProductionExecutionCli(["launch"], unknown.adapter)).resolves.toBe(1);
    expect(unknown.stderr[0]).toContain("status|preflight|run");

    const incomplete = io();
    await expect(runLc4ProductionExecutionCli(["preflight", "--manifest", "episode.json"], incomplete.adapter)).resolves.toBe(1);
    expect(incomplete.stderr[0]).toContain("requires exactly");
  });
});
