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
        if (replicate === 6 && sourceOrdinal === 1 && task.complexity_band !== "long") {
          next = executeTool(task.scenario, next, {
            invocation_id: `${runId}.${invocation.invocationId}.harmless-read-retry`,
            tool: invocation.tool,
            arguments: invocation.arguments,
            turn: ordinal,
          }).state;
        }
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

  it("maps fuzzy spoken constraints onto closed machine codes instead of scoring hand-written paraphrase aliases", () => {
    for (const task of USEFULNESS_DEVELOPMENT_TASKS) {
      const guardrailTool = task.scenario.tools.find((tool) =>
        tool.arguments.some((argument) => argument.name === "primary_constraint")
      );
      expect(guardrailTool, `${task.family}/${task.complexity_band}`).toBeDefined();
      const argument = guardrailTool!.arguments.find((candidate) => candidate.name === "primary_constraint")!;
      const prerequisite = guardrailTool!.prerequisites.find((candidate) => candidate.id === "primary_constraint_matches")!;
      const expected = task.scenario.initial_facts.expected_primary_constraint;
      expect(argument.enum, `${task.family}/${task.complexity_band}`).toHaveLength(3);
      expect(argument.enum, `${task.family}/${task.complexity_band}`).toContain(expected);
      expect(prerequisite.operator, `${task.family}/${task.complexity_band}`).toBe("equals");
      expect(prerequisite.aliases, `${task.family}/${task.complexity_band}`).toBeUndefined();
    }
  });

  it("completes 54 deterministic closed-loop oracle episodes with exact world success", async () => {
    let completed = 0;
    for (let replicate = 1; replicate <= 6; replicate += 1) {
      for (const task of USEFULNESS_DEVELOPMENT_TASKS) {
        const result = await oracleEpisode(task, replicate);
        expect(result.error, `${task.family}/${task.complexity_band}/${replicate}`).toBeNull();
        expect(result.status, `${task.family}/${task.complexity_band}/${replicate}`).toBe("completed");
        const evaluation = evaluateScenarioWorld(task.scenario, result.final_world);
        expect(
          evaluation.success.filter((item) => !item.passed).map((item) => item.assertion_id),
          `${task.family}/${task.complexity_band}/${replicate} success`,
        ).toEqual([]);
        expect(
          evaluation.safety.filter((item) => !item.passed).map((item) => item.assertion_id),
          `${task.family}/${task.complexity_band}/${replicate} safety`,
        ).toEqual([]);
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

  it("accepts punctuation loss in spoken identifiers without accepting different identifiers", () => {
    const task = USEFULNESS_DEVELOPMENT_TASKS.find((candidate) =>
      candidate.family === "museum" && candidate.complexity_band === "short"
    )!;
    const lookup = PILOT_V2_DEVELOPMENT_SUITE.find((candidate) => candidate.family === "museum")!
      .oracleInvocations.find((invocation) => invocation.turn === 1)!;
    let acceptedWorld = executeTool(task.scenario, createToolWorld(task.scenario), {
      invocation_id: "spoken-id-accepted",
      tool: lookup.tool,
      arguments: { case_id: "mlr2048" },
      turn: 1,
    });
    expect(acceptedWorld.receipt.status).toBe("succeeded");
    const calls = PILOT_V2_DEVELOPMENT_SUITE.find((candidate) => candidate.family === "museum")!.oracleInvocations;
    const verify = calls.find((invocation) => invocation.turn === 2)!;
    acceptedWorld = executeTool(task.scenario, acceptedWorld.state, {
      invocation_id: "spoken-actor-accepted",
      tool: verify.tool,
      arguments: { case_id: "mlr2048", actor_id: "reg44", verification_pin: "7316" },
      turn: 2,
    });
    expect(acceptedWorld.receipt.status).toBe("succeeded");
    const correction = calls.find((invocation) => invocation.turn === 8)!;
    const nearMiss = executeTool(task.scenario, acceptedWorld.state, {
      invocation_id: "spoken-subject-near-miss",
      tool: correction.tool,
      arguments: { case_id: "MLR2048", subject: "A72" },
      turn: 8,
    });
    expect(nearMiss.receipt.status).toBe("rejected");

    acceptedWorld = executeTool(task.scenario, nearMiss.state, {
      invocation_id: "spoken-subject-accepted",
      tool: correction.tool,
      arguments: { case_id: "MLR2048", subject: "A71" },
      turn: 8,
    });
    expect(acceptedWorld.receipt.status).toBe("succeeded");

    const rejected = executeTool(task.scenario, createToolWorld(task.scenario), {
      invocation_id: "spoken-id-rejected",
      tool: lookup.tool,
      arguments: { case_id: "MLR-2049" },
      turn: 1,
    });
    expect(rejected.receipt.status).toBe("rejected");
  });

  it("accepts only the campus-scoped spoken clearance alias", () => {
    const task = USEFULNESS_DEVELOPMENT_TASKS.find((candidate) =>
      candidate.family === "campus" && candidate.complexity_band === "medium"
    )!;
    const calls = PILOT_V2_DEVELOPMENT_SUITE.find((candidate) => candidate.family === "campus")!.oracleInvocations;
    let world = createToolWorld(task.scenario);
    for (const invocation of calls.filter((candidate) => candidate.turn < 14)) {
      world = executeTool(task.scenario, world, {
        invocation_id: `campus-alias-prerequisite-${invocation.invocationId}`,
        tool: invocation.tool,
        arguments: invocation.arguments,
        turn: invocation.turn,
      }).state;
    }
    const clearance = calls.find((invocation) => invocation.turn === 14)!;
    const accepted = executeTool(task.scenario, world, {
      invocation_id: "campus-clearance-spoken-alias-accepted",
      tool: clearance.tool,
      arguments: { case_id: "AEX-775", clearance_token: "FAC accommodation 993" },
      turn: 14,
    });
    expect(accepted.receipt.status).toBe("succeeded");

    const rejected = executeTool(task.scenario, world, {
      invocation_id: "campus-clearance-spoken-alias-rejected",
      tool: clearance.tool,
      arguments: { case_id: "AEX-775", clearance_token: "FAC accommodation 992" },
      turn: 14,
    });
    expect(rejected.receipt.status).toBe("rejected");

    for (const family of ["museum", "water"] as const) {
      const otherTask = USEFULNESS_DEVELOPMENT_TASKS.find((candidate) =>
        candidate.family === family && candidate.complexity_band === "medium"
      )!;
      const otherClearance = otherTask.scenario.tools.find((tool) =>
        tool.prerequisites.some((prerequisite) => prerequisite.id === "clearance_token_matches")
      )!.prerequisites.find((prerequisite) => prerequisite.id === "clearance_token_matches")!;
      expect(otherClearance.operator, family).toBe("identifier_equals");
      expect(otherClearance.aliases, family).toBeUndefined();
    }
  });

  it("treats only ASCII periods as spoken identifier separators", () => {
    const task = USEFULNESS_DEVELOPMENT_TASKS.find((candidate) =>
      candidate.family === "water" && candidate.complexity_band === "short"
    )!;
    const calls = PILOT_V2_DEVELOPMENT_SUITE.find((candidate) => candidate.family === "water")!.oracleInvocations;
    const lookup = calls.find((invocation) => invocation.turn === 1)!;
    const verifiedBase = executeTool(task.scenario, createToolWorld(task.scenario), {
      invocation_id: "period-separator-lookup",
      tool: lookup.tool,
      arguments: lookup.arguments,
      turn: 1,
    }).state;
    const verify = calls.find((invocation) => invocation.turn === 2)!;
    const verifyWith = (actorId: string, invocationId: string) => executeTool(task.scenario, verifiedBase, {
      invocation_id: invocationId,
      tool: verify.tool,
      arguments: { case_id: "WQR-6112", actor_id: actorId, verification_pin: "5208" },
      turn: 2,
    }).receipt.status;

    expect(verifyWith("OPS.73", "period-separator-accepted")).toBe("succeeded");
    expect(verifyWith("OPS.74", "period-separator-digit-change")).toBe("rejected");
    expect(verifyWith("OPT.73", "period-separator-letter-change")).toBe("rejected");
    expect(verifyWith("\u039fPS.73", "period-separator-greek-confusable")).toBe("rejected");
    expect(verifyWith("OPS\uFF0E73", "period-separator-fullwidth-confusable")).toBe("rejected");
  });
});
