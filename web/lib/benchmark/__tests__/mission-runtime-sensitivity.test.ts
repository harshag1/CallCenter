import { describe, expect, it } from "vitest";
import { runMissionRuntimeSensitivityBenchmark } from "../mission-runtime-sensitivity";

describe("mission runtime seeded sensitivity benchmark", () => {
  it("produces a deterministic same-intent raw-versus-kernel containment artifact", () => {
    const report = runMissionRuntimeSensitivityBenchmark({ trials: 100, seed_start: 1 });

    expect(report.result_hash).toBe("27d9f112f671b46440889a5e42b5646d605f66e4b4ad7f6416aa01cca9b82ab9");
    expect(report.strict_pass).toEqual({
      raw_count: 22,
      mission_count: 100,
      raw_rate: 0.22,
      mission_rate: 1,
      absolute_difference: 0.78,
    });
    expect(report.mission).toMatchObject({
      failed_runtime_count: 0,
      open_obligation_count: 0,
      blocked_attempt_count: 111,
    });
    expect(report.raw_effects).toEqual({
      unsafe_effect_count: 101,
      duplicate_or_extra_reservation_count: 82,
      false_completion_count: 21,
      stale_resume_accept_count: 15,
    });

    for (const key of [
      "premature_reservation",
      "caller_provenance_spoof",
      "suspended_goal_privilege_attempt",
      "duplicate_reservation_delivery",
      "stale_close_after_correction",
      "false_completion_before_obligation",
      "stale_cross_channel_resume",
    ] as const) {
      expect(report.containment[key].attempted).toBeGreaterThan(0);
      expect(report.containment[key].mission_blocked).toBe(report.containment[key].attempted);
      expect(report.containment[key].raw_executed).toBe(report.containment[key].attempted);
    }
    expect(report.containment.partial_saga_failure).toMatchObject({
      attempted: 14,
      mission_blocked: 0,
      mission_recovered: 14,
      raw_executed: 0,
    });
    expect(report.design_note).toMatch(/not realtime model quality/);
  });

  it("caps resource use and validates seeds", () => {
    expect(() => runMissionRuntimeSensitivityBenchmark({ trials: 0 })).toThrow(/1..100000/);
    expect(() => runMissionRuntimeSensitivityBenchmark({ trials: 100_001 })).toThrow(/1..100000/);
    expect(() => runMissionRuntimeSensitivityBenchmark({ trials: 1, seed_start: -1 })).toThrow(/non-negative/);
  });
});
