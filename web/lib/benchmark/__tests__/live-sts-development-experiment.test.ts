import { describe, expect, it } from "vitest";
import {
  LIVE_STS_TURNS_PER_SESSION,
  createLiveStsCells,
  createLiveStsPairs,
  liveStsScheduleArtifact,
  scoreLiveStsRuns,
  type LiveStsRunSummary,
} from "../live-sts-development-experiment";

describe("live STS development experiment", () => {
  it("freezes 16 matched pairs and 1,024 paired speech turns before results", () => {
    const pairs = createLiveStsPairs();
    const cells = createLiveStsCells();
    const schedule = liveStsScheduleArtifact();

    expect(pairs).toHaveLength(16);
    expect(cells).toHaveLength(32);
    expect(schedule.plannedVoiceToVoiceInteractions).toBe(1_024);
    expect(schedule.scheduleSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(new Set(cells.map((cell) => cell.runId)).size).toBe(cells.length);
    for (const pair of pairs) {
      expect(pair.armOrder.slice().sort()).toEqual(["full-harness", "raw-full"]);
      expect(cells.filter((cell) => cell.pairId === pair.pairId)).toHaveLength(2);
    }
  });

  it("keeps each provider paired and both scenarios represented", () => {
    const pairs = createLiveStsPairs();
    expect(pairs.filter((pair) => pair.provider === "openai")).toHaveLength(6);
    expect(pairs.filter((pair) => pair.provider === "gemini")).toHaveLength(5);
    expect(pairs.filter((pair) => pair.provider === "xai")).toHaveLength(5);
    for (const provider of ["openai", "gemini", "xai"] as const) {
      expect(new Set(pairs.filter((pair) => pair.provider === provider).map((pair) => pair.family)))
        .toEqual(new Set(["field-service-escalation", "travel-disruption"]));
    }
  });

  it("scores transport failures as failures and requires audible output on every turn", () => {
    const runs: LiveStsRunSummary[] = createLiveStsCells().map((cell) => ({
      ...cell,
      status: "completed",
      turnsPlanned: LIVE_STS_TURNS_PER_SESSION,
      turnsSent: LIVE_STS_TURNS_PER_SESSION,
      outputAudioTurns: LIVE_STS_TURNS_PER_SESSION,
      taskSuccess: true,
      safetyPassed: true,
      artifactSha256: "a".repeat(64),
    }));
    runs[0] = { ...runs[0], status: "provider_error" };
    runs[1] = { ...runs[1], outputAudioTurns: LIVE_STS_TURNS_PER_SESSION - 1 };

    const scored = scoreLiveStsRuns(runs);
    expect(scored.sessions).toBe(32);
    expect(scored.voiceToVoiceInteractions).toBe(1_023);
    expect(scored.runs.filter((run) => run.strictPass)).toHaveLength(30);
  });

  it("rejects incomplete, duplicated, or unexpected result sets", () => {
    const cells = createLiveStsCells();
    const complete: LiveStsRunSummary[] = cells.map((cell) => ({
      ...cell,
      status: "completed",
      turnsPlanned: 32,
      turnsSent: 32,
      outputAudioTurns: 32,
      taskSuccess: true,
      safetyPassed: true,
      artifactSha256: "b".repeat(64),
    }));
    expect(() => scoreLiveStsRuns(complete.slice(1))).toThrow(/incomplete or non-canonical/);
    expect(() => scoreLiveStsRuns([...complete, complete[0]])).toThrow(/incomplete or non-canonical/);
  });
});
