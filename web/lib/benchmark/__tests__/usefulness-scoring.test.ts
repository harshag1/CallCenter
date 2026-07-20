import { describe, expect, it } from "vitest";
import type { ScheduledEpisodeCondition, ScheduledEpisodeRecord } from "../closed-loop-episode";
import {
  exactMcNemarTwoSided,
  scoreUsefulnessExperiment,
  type EpisodeUsefulnessObservation,
} from "../usefulness-scoring";

function scheduled(
  pairId: string,
  condition: ScheduledEpisodeCondition,
  provider = "openai",
): ScheduledEpisodeRecord {
  return Object.freeze({
    schema_version: 1,
    protocol_id: "HACC-VTR-v1",
    episode_id: `${pairId}-${condition}`,
    pair_id: pairId,
    provider,
    model: `${provider}-realtime-test`,
    condition,
    task_family: "field-operations",
    task_id: "task-1",
    task_version: "1.0.0",
    complexity_band: "medium",
    schedule_sha256: "a".repeat(64),
    scheduled_at: "2026-07-20T20:00:00.000Z",
    record_sha256: "b".repeat(64),
  });
}

function observation(record: ScheduledEpisodeRecord, pass: boolean): EpisodeUsefulnessObservation {
  return Object.freeze({
    schema_version: 1,
    episode_id: record.episode_id,
    pair_id: record.pair_id,
    provider: record.provider,
    model: record.model,
    condition: record.condition,
    transport_terminal: pass,
    world_outcome_pass: pass,
    false_terminal_claim: false,
    spoken_policy_pass: pass,
    within_limits: pass,
    task_completion_pass: pass,
    model_integrity_pass: pass,
    system_integrity_pass: pass,
    attempted_semantic_actions: pass ? 4 : 1,
    semantic_opportunities: 5,
    estimated_cost_usd: 0.25,
    failure_class: pass ? null : "task_failed",
  });
}

describe("usefulness benchmark scoring", () => {
  it("keeps every scheduled episode in ITT and treats a missing result as a failure", () => {
    const pairOneRaw = scheduled("pair-1", "raw-memory-v1");
    const pairOneHarness = scheduled("pair-1", "full-harness-v1");
    const pairTwoRaw = scheduled("pair-2", "raw-memory-v1");
    const pairTwoHarness = scheduled("pair-2", "full-harness-v1");
    const result = scoreUsefulnessExperiment({
      scheduled: [pairOneRaw, pairOneHarness, pairTwoRaw, pairTwoHarness],
      observations: [
        observation(pairOneRaw, false),
        observation(pairOneHarness, true),
        observation(pairTwoRaw, true),
        // The missing harness observation remains an ITT non-completion.
      ],
    });

    expect(result).toMatchObject({
      scheduled_episodes: 4,
      observed_episodes: 3,
      missing_observations: 1,
    });
    expect(result.provider_effects[0]).toMatchObject({
      scheduled_pairs: 2,
      baseline_completions: 1,
      harness_completions: 1,
      harness_only: 1,
      baseline_only: 1,
      paired_risk_difference: 0,
      exact_mcnemar_two_sided_p: 1,
    });
    expect(result.result_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("computes the exact conditional McNemar tail", () => {
    expect(exactMcNemarTwoSided(0, 0)).toBe(1);
    expect(exactMcNemarTwoSided(5, 0)).toBeCloseTo(0.0625, 12);
    expect(exactMcNemarTwoSided(8, 0)).toBeCloseTo(0.0078125, 12);
    expect(exactMcNemarTwoSided(7, 1)).toBeCloseTo(0.0703125, 12);
  });

  it("rejects a task-completion bit that is inconsistent with its components", () => {
    const record = scheduled("pair-invalid", "raw-memory-v1");
    expect(() => scoreUsefulnessExperiment({
      scheduled: [record, scheduled("pair-invalid", "full-harness-v1")],
      observations: [{ ...observation(record, true), world_outcome_pass: false }],
    })).toThrow(/self-inconsistent task completion label/);
  });
});
