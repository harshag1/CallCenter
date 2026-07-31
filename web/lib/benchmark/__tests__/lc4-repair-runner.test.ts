import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { sha256Hex, verifyEventChain } from "../artifacts";
import {
  createConversationalRepairPlan,
  type ArmBlindRepairObservation,
  type ConversationalRepairPlan,
} from "../conversational-repair";
import {
  runLc4RepairEpisode,
  type Lc4CallerPlayback,
  type Lc4CanonicalCallerTurn,
  type Lc4RepairRunnerInput,
} from "../lc4-repair-runner";

const sha = (value: string) => sha256Hex(`lc4-runner-test:${value}`);
const bytesSha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const REPAIR_BYTES = Object.freeze({
  "repair.resolve.1": Uint8Array.from([1, 0, 2, 0, 3, 0, 4, 0]),
  "repair.resolve.2": Uint8Array.from([5, 0, 6, 0, 7, 0, 8, 0]),
  "repair.followup.1": Uint8Array.from([9, 0, 10, 0, 11, 0, 12, 0]),
  "repair.followup.2": Uint8Array.from([13, 0, 14, 0, 15, 0, 16, 0]),
});

const PLAN: ConversationalRepairPlan = createConversationalRepairPlan({
  schema_version: 1,
  protocol_id: "HACC-LC4-v1",
  scenario_id: "scenario.runner",
  scenario_version: "version.1",
  stages: ["resolve", "followup"].map((stage) => ({
    stage_id: `stage.${stage}`,
    applicable_blockers: ["required_evidence_missing"] as const,
  })),
  pcm_inventory: (["resolve", "followup"] as const).flatMap((stage) =>
    ([1, 2] as const).map((ordinal) => {
      const id = `repair.${stage}.${ordinal}` as keyof typeof REPAIR_BYTES;
      const bytes = REPAIR_BYTES[id];
      return {
        repair_pcm_id: id,
        stage_id: `stage.${stage}`,
        blocker_code: "required_evidence_missing" as const,
        repair_ordinal: ordinal,
        source_text_sha256: sha(`repair text:${stage}:${ordinal}`),
        pcm_sha256: bytesSha(bytes),
        byte_length: bytes.byteLength,
        sample_rate_hz: 16_000 as const,
        channels: 1 as const,
        encoding: "pcm16le" as const,
        voice_id: "voice.fixture",
        repeats_spoken_fact_ids: [],
      };
    })),
});

function canonicalTurn(ordinal: number, stageId = "stage.resolve"): Lc4CanonicalCallerTurn {
  const bytes = Uint8Array.from([ordinal, 0, ordinal + 1, 0]);
  return {
    caller_turn_id: `turn.${ordinal}`,
    canonical_opportunity_id: `opportunity.${ordinal}`,
    stage_id: stageId,
    pcm: {
      caller_pcm_id: `caller.${ordinal}`,
      pcm_sha256: bytesSha(bytes),
      byte_length: bytes.byteLength,
      sample_rate_hz: 16_000,
      channels: 1,
      encoding: "pcm16le",
      bytes,
    },
  };
}

function observation(
  episodeId: string,
  turn: Lc4CanonicalCallerTurn,
  unmet = true,
): ArmBlindRepairObservation {
  return {
    schema_version: 1,
    episode_id: episodeId,
    caller_turn_id: turn.caller_turn_id,
    canonical_opportunity_id: turn.canonical_opportunity_id,
    stage_id: turn.stage_id,
    deadline_reached: true,
    common_state_sha256: sha(`common:${turn.caller_turn_id}`),
    listener_heard_semantics_sha256: sha(`heard:${turn.caller_turn_id}`),
    spoken_caller_fact_ids: [],
    visible_receipt_ids: [],
    visible_worker_result_ids: [],
    unmet_blocker_codes: unmet ? ["required_evidence_missing"] : [],
  };
}

function terminal(missionComplete = true) {
  return {
    scenario_invalid: false,
    system_failure: false,
    harness_deadlock: false,
    transport_failure: false,
    mission_complete: missionComplete,
    absorbing_model_policy_attempt: false,
  } as const;
}

function runnerInput(input: Partial<Lc4RepairRunnerInput> & Readonly<{
  episode_id?: string;
  canonical_turns?: readonly Lc4CanonicalCallerTurn[];
  playback_log?: Lc4CallerPlayback[];
}> = {}): Lc4RepairRunnerInput {
  const episodeId = input.episode_id ?? "episode.runner";
  const turns = input.canonical_turns ?? [canonicalTurn(1), canonicalTurn(2)];
  const playbackLog = input.playback_log ?? [];
  return {
    run_id: input.run_id ?? `run.${episodeId}`,
    episode_id: episodeId,
    plan: input.plan ?? PLAN,
    canonical_turns: turns,
    load_repair_pcm: input.load_repair_pcm ?? ((fixture) => {
      const bytes = REPAIR_BYTES[fixture.repair_pcm_id as keyof typeof REPAIR_BYTES];
      if (!bytes) throw new Error("missing test repair bytes");
      return bytes.slice();
    }),
    play_caller_pcm: input.play_caller_pcm ?? ((playback) => {
      playbackLog.push(playback);
      if (playback.kind === "repair") return { repair_observation: null };
      const turn = turns[playback.canonical_ordinal - 1]!;
      return { repair_observation: observation(episodeId, turn, playback.canonical_ordinal === 1) };
    }),
    terminal_evidence: input.terminal_evidence ?? (() => terminal()),
    now: input.now ?? (() => "2026-07-21T20:00:00.000Z"),
  };
}

describe("LC4 repair development runner", () => {
  it("verifies and plays prerecorded repair PCM without advancing the canonical horizon", async () => {
    const playbackLog: Lc4CallerPlayback[] = [];
    const result = await runLc4RepairEpisode(runnerInput({ playback_log: playbackLog }));

    expect(playbackLog.map((playback) => playback.kind)).toEqual(["canonical", "repair", "canonical"]);
    expect(playbackLog.map((playback) => playback.canonical_ordinal)).toEqual([1, 1, 2]);
    expect(playbackLog.map((playback) => playback.advances_canonical_horizon)).toEqual([true, false, true]);
    expect(result.canonical_horizon_planned).toBe(2);
    expect(result.canonical_horizon_executed).toBe(2);
    expect(result.canonical_opportunity_ids).toEqual(["opportunity.1", "opportunity.2"]);
    expect(result.repair_turns_played).toBe(1);
    expect(result.repair_state.repair_count).toBe(1);
    expect(result.terminal.terminal_class).toBe("recovered");
    expect(verifyEventChain(result.journal)).toMatchObject({ valid: true });

    const repair = playbackLog[1]!;
    expect(repair.kind).toBe("repair");
    if (repair.kind === "repair") {
      expect(bytesSha(repair.pcm.bytes)).toBe(bytesSha(REPAIR_BYTES["repair.resolve.1"]));
      expect(repair.source_text_sha256).toBe(sha("repair text:resolve:1"));
      expect(repair.repair_ordinal).toBe(1);
    }
    const repairEvents = result.journal.filter((event) =>
      event.event_type === "lc4.caller_audio.played"
      && typeof event.payload === "object"
      && event.payload !== null
      && "kind" in event.payload
      && event.payload.kind === "repair"
    );
    expect(repairEvents).toHaveLength(1);
    expect(repairEvents[0]!.payload).toMatchObject({
      canonical_ordinal: 1,
      canonical_horizon_count: 2,
      advances_canonical_horizon: false,
      pcm_sha256: bytesSha(REPAIR_BYTES["repair.resolve.1"]),
    });
  });

  it("produces the same arm-blind policy trace for raw and HACC arms", async () => {
    const runArm = async (episodeId: string) => {
      const playbackLog: Lc4CallerPlayback[] = [];
      const result = await runLc4RepairEpisode(runnerInput({
        run_id: `run.${episodeId}`,
        episode_id: episodeId,
        playback_log: playbackLog,
      }));
      return {
        result,
        policy: playbackLog.map((playback) => playback.kind === "repair"
          ? `${playback.canonical_opportunity_id}:${playback.blocker_code}:${playback.pcm.pcm_sha256}`
          : null).filter(Boolean),
      };
    };

    const raw = await runArm("episode.raw");
    const hacc = await runArm("episode.hacc");
    expect(raw.policy).toEqual(hacc.policy);
    expect(raw.result.arm_blind_repair_trace_sha256).toBe(hacc.result.arm_blind_repair_trace_sha256);
    expect(raw.result.plan_sha256).toBe(hacc.result.plan_sha256);
  });

  it("plays ordinal two after a later response in the same stage without creating a repair horizon", async () => {
    const turns = [canonicalTurn(1), canonicalTurn(2), canonicalTurn(3)];
    const playbackLog: Lc4CallerPlayback[] = [];
    const result = await runLc4RepairEpisode(runnerInput({
      canonical_turns: turns,
      playback_log: playbackLog,
      play_caller_pcm: (playback) => {
        playbackLog.push(playback);
        if (playback.kind === "repair") return { repair_observation: null };
        return { repair_observation: observation("episode.runner", turns[playback.canonical_ordinal - 1]!) };
      },
    }));

    expect(playbackLog.map((playback) =>
      playback.kind === "repair" ? `repair-${playback.repair_ordinal}` : `canonical-${playback.canonical_ordinal}`
    )).toEqual(["canonical-1", "repair-1", "canonical-2", "repair-2", "canonical-3"]);
    expect(result.canonical_horizon_executed).toBe(3);
    expect(result.repair_turns_played).toBe(2);
    expect(result.repair_state.decisions[2]).toMatchObject({
      selection: null,
      no_repair_reason: "stage_budget_exhausted",
    });
  });

  it("fails closed before repair playback when preregistered PCM bytes do not match", async () => {
    const playbackLog: Lc4CallerPlayback[] = [];
    const result = await runLc4RepairEpisode(runnerInput({
      playback_log: playbackLog,
      load_repair_pcm: () => Uint8Array.from([9, 0, 9, 0, 9, 0, 9, 0]),
    }));

    expect(playbackLog.map((playback) => playback.kind)).toEqual(["canonical"]);
    expect(result.canonical_horizon_executed).toBe(1);
    expect(result.repair_turns_played).toBe(0);
    expect(result.terminal.terminal_class).toBe("scenario-invalid");
    expect(result.failure_message).toContain("content hash does not match");
    expect(verifyEventChain(result.journal).valid).toBe(true);
  });

  it("enforces the four-repair episode budget while executing every canonical opportunity", async () => {
    const turns = [
      canonicalTurn(1),
      canonicalTurn(2),
      canonicalTurn(3, "stage.followup"),
      canonicalTurn(4, "stage.followup"),
      canonicalTurn(5),
      canonicalTurn(6, "stage.followup"),
    ];
    const playbackLog: Lc4CallerPlayback[] = [];
    const result = await runLc4RepairEpisode(runnerInput({
      canonical_turns: turns,
      playback_log: playbackLog,
      play_caller_pcm: (playback) => {
        playbackLog.push(playback);
        if (playback.kind === "repair") return { repair_observation: null };
        return { repair_observation: observation("episode.runner", turns[playback.canonical_ordinal - 1]!) };
      },
    }));

    expect(result.canonical_horizon_executed).toBe(6);
    expect(playbackLog.filter((playback) => playback.kind === "canonical")).toHaveLength(6);
    expect(playbackLog.filter((playback) => playback.kind === "repair")).toHaveLength(4);
    expect(result.repair_state.decisions.slice(4).map((decision) => decision.no_repair_reason))
      .toEqual(["episode_budget_exhausted", "episode_budget_exhausted"]);
  });

  it("rejects repair playback that tries to recursively create another repair horizon", async () => {
    const turns = [canonicalTurn(1)];
    const result = await runLc4RepairEpisode(runnerInput({
      canonical_turns: turns,
      play_caller_pcm: (playback) => ({
        repair_observation: observation("episode.runner", turns[0]!, playback.kind === "canonical"),
      }),
    }));

    expect(result.terminal.terminal_class).toBe("scenario-invalid");
    expect(result.failure_message).toContain("recursive repair horizon");
  });

  it("classifies playback failures as transport and incomplete repaired calls as model-unrecovered", async () => {
    const transport = await runLc4RepairEpisode(runnerInput({
      play_caller_pcm: () => {
        throw new Error("socket closed");
      },
    }));
    expect(transport.terminal.terminal_class).toBe("transport");
    expect(transport.canonical_horizon_executed).toBe(0);

    const unrecovered = await runLc4RepairEpisode(runnerInput({
      terminal_evidence: () => terminal(false),
    }));
    expect(unrecovered.terminal.terminal_class).toBe("model-unrecovered");
    expect(unrecovered.repair_state.repair_count).toBe(1);
  });

  it("rejects hidden arm metadata at the integrated oracle boundary", async () => {
    const turns = [canonicalTurn(1)];
    const result = await runLc4RepairEpisode(runnerInput({
      canonical_turns: turns,
      play_caller_pcm: () => ({
        repair_observation: {
          ...observation("episode.runner", turns[0]!),
          condition: "full-harness-v1",
        } as ArmBlindRepairObservation,
      }),
    }));

    expect(result.terminal.terminal_class).toBe("scenario-invalid");
    expect(result.failure_message).toContain("repair oracle rejected");
  });
});
