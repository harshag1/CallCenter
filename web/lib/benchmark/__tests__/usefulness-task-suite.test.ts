import { describe, expect, it } from "vitest";
import { sha256Hex } from "../artifacts";
import { freezeCallerAudioIndex } from "../caller-world-scheduler";
import { runClosedLoopEpisode } from "../closed-loop-episode";
import { auditConditionParity, compileConditionSuite } from "../condition-compiler";
import { PILOT_V2_DEVELOPMENT_SUITE } from "../pilot-v2-suite";
import { createToolWorld, evaluateScenarioWorld, executeTool } from "../tool-world";
import {
  USEFULNESS_COMPLEXITY_BANDS,
  USEFULNESS_DEVELOPMENT_SUITE_SHA256,
  USEFULNESS_DEVELOPMENT_TASKS,
  createUsefulnessCallerSchedulePlan,
  type UsefulnessDevelopmentTask,
} from "../usefulness-task-suite";

function audio(task: UsefulnessDevelopmentTask) {
  const manifest = sha256Hex(`manifest:${task.suite_sha256}`);
  return freezeCallerAudioIndex({
    schema_version: 1,
    scenario_id: task.scenario.id,
    scenario_version: task.scenario.version,
    fixture_set_id: `caf_${sha256Hex(task.suite_sha256).slice(0, 24)}`,
    fixture_manifest_sha256: manifest,
    rendition: "pcm16le_mono_24000",
    turns: Object.fromEntries(task.scenario.caller.turns.map((turn) => [turn.id, {
      turn_id: turn.id,
      fixture_set_id: `caf_${sha256Hex(task.suite_sha256).slice(0, 24)}`,
      fixture_manifest_sha256: manifest,
      source_text_sha256: sha256Hex(turn.utterance),
      rendition: "pcm16le_mono_24000" as const,
      pcm_sha256: sha256Hex(`pcm:${turn.id}`),
      byte_length: 48_000,
      sample_rate_hz: 24_000 as const,
      channels: 1 as const,
      encoding: "pcm16" as const,
    }])),
  });
}

async function oracleEpisode(task: UsefulnessDevelopmentTask, replicate: number) {
  const template = PILOT_V2_DEVELOPMENT_SUITE.find((candidate) => candidate.family === task.family)!;
  const originalOrdinal = new Map(template.scenario.caller.turns.map((turn, index) => [turn.id, index + 1]));
  const runId = `${task.family}-${task.complexity_band}-${replicate}`;
  return runClosedLoopEpisode({
    episode: {
      episode_id: runId,
      pair_id: `pair-${runId}`,
      provider: "scripted-oracle",
      model: "scripted-oracle-v1",
      condition: "full-harness-v1",
      task_family: task.family,
      task_id: task.scenario.id,
      task_version: task.scenario.version,
      complexity_band: task.complexity_band,
      scheduled_at: "2026-07-20T20:00:00.000Z",
    },
    caller_plan: createUsefulnessCallerSchedulePlan({
      task,
      run_id: runId,
      created_at: "2026-07-20T20:00:00.000Z",
      audio: audio(task),
    }),
    initial_world: createToolWorld(task.scenario),
    max_turns: task.scenario.max_turns,
    on_scheduled: () => undefined,
    execute_turn: ({ selection, ordinal, world }) => {
      const sourceOrdinal = originalOrdinal.get(selection.turn_id);
      if (!sourceOrdinal) return { world };
      let next = world;
      for (const invocation of template.oracleInvocations.filter((candidate) => candidate.turn === sourceOrdinal)) {
        next = executeTool(task.scenario, next, {
          invocation_id: `${runId}.${invocation.invocationId}`,
          tool: invocation.tool,
          arguments: invocation.arguments,
          turn: ordinal,
        }).state;
      }
      return { world: next };
    },
    now: () => "2026-07-20T20:00:01.000Z",
  });
}

describe("voice task reliability development suite", () => {
  it("contains three independent families at all three semantic complexity bands", () => {
    expect(USEFULNESS_DEVELOPMENT_TASKS).toHaveLength(9);
    expect(new Set(USEFULNESS_DEVELOPMENT_TASKS.map((task) => task.family))).toEqual(new Set(["museum", "campus", "water"]));
    expect(new Set(USEFULNESS_DEVELOPMENT_TASKS.map((task) => task.complexity_band))).toEqual(new Set(USEFULNESS_COMPLEXITY_BANDS));
    expect(USEFULNESS_DEVELOPMENT_SUITE_SHA256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps raw-memory and full-harness information/tool parity for every task", () => {
    for (const task of USEFULNESS_DEVELOPMENT_TASKS) {
      const suite = compileConditionSuite(task.compiler_input);
      expect(auditConditionParity(suite), `${task.family}/${task.complexity_band}`).toMatchObject({ valid: true });
      expect(suite.conditions["raw-memory"].visibleCapabilities.map((capability) => capability.name)).toContain("durable_memory");
      expect(suite.conditions["full-harness"].providerTools).toEqual(suite.conditions["raw-memory"].providerTools);
    }
  });

  it("completes 54 deterministic closed-loop oracle episodes with exact world success", async () => {
    let completed = 0;
    for (let replicate = 1; replicate <= 6; replicate += 1) {
      for (const task of USEFULNESS_DEVELOPMENT_TASKS) {
        const result = await oracleEpisode(task, replicate);
        expect(result.error, `${task.family}/${task.complexity_band}/${replicate}`).toBeNull();
        expect(result.status, `${task.family}/${task.complexity_band}/${replicate}`).toBe("completed");
        expect(evaluateScenarioWorld(task.scenario, result.final_world).success.every((item) => item.passed)).toBe(true);
        completed += 1;
      }
    }
    expect(completed).toBe(54);
  });

  it("blocks progression when the agent omits a required action instead of feeding incoherent caller turns", async () => {
    const task = USEFULNESS_DEVELOPMENT_TASKS.find((candidate) => candidate.complexity_band === "short")!;
    const runId = "omission-block-test";
    const result = await runClosedLoopEpisode({
      episode: {
        episode_id: runId,
        pair_id: "omission-block-pair",
        provider: "scripted-omission",
        model: "scripted-omission-v1",
        condition: "raw-memory-v1",
        task_family: task.family,
        task_id: task.scenario.id,
        task_version: task.scenario.version,
        complexity_band: task.complexity_band,
        scheduled_at: "2026-07-20T20:00:00.000Z",
      },
      caller_plan: createUsefulnessCallerSchedulePlan({
        task,
        run_id: runId,
        created_at: "2026-07-20T20:00:00.000Z",
        audio: audio(task),
      }),
      initial_world: createToolWorld(task.scenario),
      max_turns: task.scenario.max_turns,
      on_scheduled: () => undefined,
      execute_turn: ({ world }) => ({ world }),
      now: () => "2026-07-20T20:00:01.000Z",
    });
    expect(result.status).toBe("caller_blocked");
    expect(result.turns).toHaveLength(2);
  });
});
