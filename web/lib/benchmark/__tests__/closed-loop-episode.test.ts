import { describe, expect, it } from "vitest";
import transportScenarioJson from "../../../../benchmarks/voice-long-horizon/scenarios/transport-smoke-v1.json";
import { sha256Hex } from "../artifacts";
import { freezeCallerAudioIndex, type CallerWorldSchedulePlan } from "../caller-world-scheduler";
import {
  replayClosedLoopEpisode,
  runClosedLoopEpisode,
  type ClosedLoopEpisodeInput,
} from "../closed-loop-episode";
import { BenchmarkScenarioSchema } from "../scenario-schema";
import { createToolWorld, ToolWorldStateSchema } from "../tool-world";

const scenario = BenchmarkScenarioSchema.parse({
  ...transportScenarioJson,
  id: "closed-loop-episode-test",
  version: "1.0.0",
  max_turns: 3,
  caller: {
    ...transportScenarioJson.caller,
    turns: [
      {
        id: "start",
        phase: "start",
        utterance: "Please check the service.",
        tags: ["task"],
        fact_updates: [],
        expected_behavior: ["Inspect authoritative service state."],
      },
      {
        id: "ready",
        phase: "follow-up",
        utterance: "Great, continue with the ready service.",
        tags: ["task"],
        fact_updates: [],
        expected_behavior: ["Continue on the ready branch."],
      },
      {
        id: "down",
        phase: "follow-up",
        utterance: "The service is down. Explain the recovery path.",
        tags: ["failure_recovery"],
        fact_updates: [],
        expected_behavior: ["Continue on the recovery branch."],
      },
    ],
  },
});

const manifestHash = sha256Hex("closed-loop-fixture-manifest");
const audio = freezeCallerAudioIndex({
  schema_version: 1,
  scenario_id: scenario.id,
  scenario_version: scenario.version,
  fixture_set_id: "caf_closed_loop_episode_0001",
  fixture_manifest_sha256: manifestHash,
  rendition: "pcm16le_mono_24000",
  turns: Object.fromEntries(scenario.caller.turns.map((turn) => [turn.id, {
    turn_id: turn.id,
    fixture_set_id: "caf_closed_loop_episode_0001",
    fixture_manifest_sha256: manifestHash,
    source_text_sha256: sha256Hex(turn.utterance),
    rendition: "pcm16le_mono_24000" as const,
    pcm_sha256: sha256Hex(`audio:${turn.id}`),
    byte_length: 48_000,
    sample_rate_hz: 24_000 as const,
    channels: 1 as const,
    encoding: "pcm16" as const,
  }])),
});

function plan(episodeId = "closed-loop-episode-001"): CallerWorldSchedulePlan {
  return {
    schema_version: 1,
    run_id: episodeId,
    created_at: "2026-07-20T20:00:00.000Z",
    scenario,
    audio,
    fact_allowlist: [],
    observable_world_fact_keys: ["service_status"],
    stages: [
      { id: "start", candidates: [{ turn_id: "start", audio_turn_id: "start", when: [] }] },
      {
        id: "service-state",
        candidates: [
          {
            turn_id: "ready",
            audio_turn_id: "ready",
            when: [{ kind: "world_fact_equals", fact_key: "service_status", value: "operational" }],
          },
          {
            turn_id: "down",
            audio_turn_id: "down",
            when: [{ kind: "world_fact_equals", fact_key: "service_status", value: "degraded" }],
          },
        ],
      },
    ],
    opportunities: [],
  };
}

function episode(episodeId = "closed-loop-episode-001"): ClosedLoopEpisodeInput["episode"] {
  return {
    episode_id: episodeId,
    pair_id: "pair-closed-loop-001",
    provider: "scripted",
    model: "scripted-v1",
    condition: "raw-memory-v1",
    task_family: "customer-operations",
    task_id: scenario.id,
    task_version: scenario.version,
    complexity_band: "short",
    scheduled_at: "2026-07-20T20:00:00.000Z",
  };
}

describe("closed-loop usefulness episode", () => {
  it("persists the schedule before execution, adapts to world state, and replays independently", async () => {
    let scheduled = false;
    const seenTurns: string[] = [];
    const result = await runClosedLoopEpisode({
      episode: episode(),
      caller_plan: plan(),
      initial_world: createToolWorld(scenario),
      max_turns: 3,
      on_scheduled: (record) => {
        scheduled = true;
        expect(record.condition).toBe("raw-memory-v1");
        expect(record.record_sha256).toMatch(/^[a-f0-9]{64}$/);
      },
      execute_turn: ({ selection, world }) => {
        expect(scheduled).toBe(true);
        seenTurns.push(selection.turn_id);
        if (selection.turn_id !== "start") return { world };
        return {
          world: ToolWorldStateSchema.parse({
            ...structuredClone(world),
            facts: { ...structuredClone(world.facts), service_status: "operational" },
            next_event_sequence: world.next_event_sequence + 1,
          }),
        };
      },
      now: () => "2026-07-20T20:00:01.000Z",
    });

    expect(result.status).toBe("completed");
    expect(seenTurns).toEqual(["start", "ready"]);
    expect(result.turns).toHaveLength(2);
    const replay = replayClosedLoopEpisode(plan(), result);
    expect(replay.errors).toEqual([]);
    expect(replay).toMatchObject({ valid: true, replayed_turns: 2 });
  });

  it("retains scheduled episodes when the executor fails", async () => {
    let persisted = 0;
    const result = await runClosedLoopEpisode({
      episode: episode("closed-loop-episode-error"),
      caller_plan: plan("closed-loop-episode-error"),
      initial_world: createToolWorld(scenario),
      max_turns: 3,
      on_scheduled: () => { persisted += 1; },
      execute_turn: () => { throw new Error("synthetic provider connect failure"); },
      now: () => "2026-07-20T20:00:01.000Z",
    });
    expect(persisted).toBe(1);
    expect(result.status).toBe("executor_error");
    expect(result.turns).toEqual([]);
    expect(result.error).toMatchObject({ class: "Error" });
  });

  it("fails replay when a persisted selection is mutated", async () => {
    const p = plan("closed-loop-episode-mutation");
    const result = await runClosedLoopEpisode({
      episode: episode("closed-loop-episode-mutation"),
      caller_plan: p,
      initial_world: createToolWorld(scenario),
      max_turns: 3,
      on_scheduled: () => undefined,
      execute_turn: ({ world }) => ({ world }),
      now: () => "2026-07-20T20:00:01.000Z",
    });
    const mutated = {
      ...result,
      turns: result.turns.map((turn, index) => index === 0
        ? { ...turn, selection: { ...turn.selection, turn_id: "ready" } }
        : turn),
    };
    expect(replayClosedLoopEpisode(p, mutated).valid).toBe(false);
  });
});
