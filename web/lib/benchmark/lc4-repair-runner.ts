import { createHash } from "node:crypto";

import {
  appendEventEnvelope,
  canonicalJson,
  type BenchmarkEventEnvelope,
  type JsonValue,
  sha256Hex,
  startEventChain,
} from "./artifacts";
import {
  classifyConversationalRepairTerminal,
  createConversationalRepairState,
  decideConversationalRepair,
  type ArmBlindRepairObservation,
  type ConversationalRepairDecision,
  type ConversationalRepairPcm,
  type ConversationalRepairPlan,
  type ConversationalRepairState,
  type ConversationalRepairTerminalDisposition,
  type ConversationalRepairTerminalEvidence,
} from "./conversational-repair";

const TRACE_DOMAIN = "hacc/lc4/development-repair-trace/v1\n";
const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-z][a-z0-9_.-]{1,127}$/;

export type Lc4CanonicalCallerPcm = Readonly<{
  caller_pcm_id: string;
  pcm_sha256: string;
  byte_length: number;
  sample_rate_hz: 16_000 | 24_000;
  channels: 1;
  encoding: "pcm16le";
  bytes: Uint8Array;
}>;

export type Lc4CanonicalCallerTurn = Readonly<{
  caller_turn_id: string;
  canonical_opportunity_id: string;
  stage_id: string;
  pcm: Lc4CanonicalCallerPcm;
}>;

type Lc4PlaybackPcm = Readonly<{
  pcm_id: string;
  pcm_sha256: string;
  byte_length: number;
  sample_rate_hz: 16_000 | 24_000;
  channels: 1;
  encoding: "pcm16le";
  bytes: Uint8Array;
}>;

export type Lc4CanonicalPlayback = Readonly<{
  kind: "canonical";
  episode_id: string;
  caller_turn_id: string;
  canonical_opportunity_id: string;
  stage_id: string;
  canonical_ordinal: number;
  canonical_horizon_count: number;
  advances_canonical_horizon: true;
  pcm: Lc4PlaybackPcm;
}>;

export type Lc4RepairPlayback = Readonly<{
  kind: "repair";
  episode_id: string;
  caller_turn_id: string;
  canonical_opportunity_id: string;
  stage_id: string;
  blocker_code: string;
  canonical_ordinal: number;
  canonical_horizon_count: number;
  advances_canonical_horizon: false;
  source_text_sha256: string;
  voice_id: string;
  pcm: Lc4PlaybackPcm;
}>;

export type Lc4CallerPlayback = Lc4CanonicalPlayback | Lc4RepairPlayback;

/**
 * Canonical playback returns the arm-blind projection observed after the model
 * response. Repair playback cannot trigger another repair decision.
 */
export type Lc4CallerPlaybackResult = Readonly<{
  repair_observation: ArmBlindRepairObservation | null;
}>;

export type Lc4TerminalEvidenceBase = Omit<ConversationalRepairTerminalEvidence, "repair_count">;

export type Lc4RepairRunnerInput = Readonly<{
  run_id: string;
  episode_id: string;
  plan: ConversationalRepairPlan;
  canonical_turns: readonly Lc4CanonicalCallerTurn[];
  load_repair_pcm: (fixture: ConversationalRepairPcm) => Uint8Array | Promise<Uint8Array>;
  play_caller_pcm: (playback: Lc4CallerPlayback) =>
    Lc4CallerPlaybackResult | Promise<Lc4CallerPlaybackResult>;
  terminal_evidence: () => Lc4TerminalEvidenceBase | Promise<Lc4TerminalEvidenceBase>;
  now?: () => string;
}>;

export type Lc4RepairRunnerResult = Readonly<{
  schema_version: 1;
  protocol_id: "HACC-LC4-v1";
  run_id: string;
  episode_id: string;
  plan_sha256: string;
  canonical_horizon_planned: number;
  canonical_horizon_executed: number;
  repair_turns_played: number;
  canonical_opportunity_ids: readonly string[];
  repair_state: ConversationalRepairState;
  arm_blind_repair_trace_sha256: string;
  terminal: ConversationalRepairTerminalDisposition;
  failure_message: string | null;
  journal: readonly BenchmarkEventEnvelope[];
}>;

type FailureKind = "scenario-invalid" | "system-failure" | "transport";

class Lc4RunnerFailure extends Error {
  readonly failureKind: FailureKind;

  constructor(failureKind: FailureKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "Lc4RunnerFailure";
    this.failureKind = failureKind;
  }
}

type TraceEntry = Readonly<{
  caller_turn_id: string;
  canonical_opportunity_id: string;
  stage_id: string;
  deadline_reached: boolean;
  common_state_sha256: string;
  listener_heard_semantics_sha256: string;
  spoken_caller_fact_ids: readonly string[];
  visible_receipt_ids: readonly string[];
  visible_worker_result_ids: readonly string[];
  unmet_blocker_codes: readonly string[];
  selection: ConversationalRepairDecision["selection"];
  no_repair_reason: ConversationalRepairDecision["no_repair_reason"];
}>;

function pcmSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertPcmBytes(
  label: string,
  expected: Readonly<{
    pcm_sha256: string;
    byte_length: number;
    sample_rate_hz: 16_000 | 24_000;
    encoding: "pcm16le";
    channels: 1;
  }>,
  bytes: Uint8Array,
): void {
  if (!(bytes instanceof Uint8Array)) {
    throw new Lc4RunnerFailure("scenario-invalid", `${label} did not resolve to bytes`);
  }
  if (!SHA256.test(expected.pcm_sha256)) {
    throw new Lc4RunnerFailure("scenario-invalid", `${label} has an invalid registered SHA-256`);
  }
  if (expected.encoding !== "pcm16le" || expected.channels !== 1) {
    throw new Lc4RunnerFailure("scenario-invalid", `${label} must be mono PCM16LE`);
  }
  if (expected.sample_rate_hz !== 16_000 && expected.sample_rate_hz !== 24_000) {
    throw new Lc4RunnerFailure("scenario-invalid", `${label} has an unsupported sample rate`);
  }
  if (!Number.isSafeInteger(expected.byte_length)
    || expected.byte_length <= 0
    || expected.byte_length % 2 !== 0
    || bytes.byteLength !== expected.byte_length) {
    throw new Lc4RunnerFailure("scenario-invalid", `${label} byte length does not match its registration`);
  }
  if (pcmSha256(bytes) !== expected.pcm_sha256) {
    throw new Lc4RunnerFailure("scenario-invalid", `${label} content hash does not match its registration`);
  }
}

function assertCanonicalSchedule(input: Lc4RepairRunnerInput): void {
  if (input.canonical_turns.length === 0) {
    throw new Lc4RunnerFailure("scenario-invalid", "canonical caller schedule is empty");
  }
  const turnIds = new Set<string>();
  const opportunityIds = new Set<string>();
  const stages = new Set(input.plan.stages.map((stage) => stage.stage_id));
  for (const turn of input.canonical_turns) {
    if (!IDENTIFIER.test(turn.caller_turn_id)
      || !IDENTIFIER.test(turn.canonical_opportunity_id)
      || !IDENTIFIER.test(turn.stage_id)
      || !IDENTIFIER.test(turn.pcm.caller_pcm_id)) {
      throw new Lc4RunnerFailure("scenario-invalid", "canonical caller schedule contains a noncanonical ID");
    }
    if (turnIds.has(turn.caller_turn_id)) {
      throw new Lc4RunnerFailure("scenario-invalid", `duplicate caller turn ${turn.caller_turn_id}`);
    }
    if (opportunityIds.has(turn.canonical_opportunity_id)) {
      throw new Lc4RunnerFailure(
        "scenario-invalid",
        `duplicate canonical opportunity ${turn.canonical_opportunity_id}`,
      );
    }
    if (!stages.has(turn.stage_id)) {
      throw new Lc4RunnerFailure("scenario-invalid", `caller turn ${turn.caller_turn_id} has an unknown stage`);
    }
    turnIds.add(turn.caller_turn_id);
    opportunityIds.add(turn.canonical_opportunity_id);
  }
}

function assertObservationIdentity(
  observation: ArmBlindRepairObservation,
  episodeId: string,
  turn: Lc4CanonicalCallerTurn,
): void {
  if (observation.episode_id !== episodeId
    || observation.caller_turn_id !== turn.caller_turn_id
    || observation.canonical_opportunity_id !== turn.canonical_opportunity_id
    || observation.stage_id !== turn.stage_id) {
    throw new Lc4RunnerFailure(
      "scenario-invalid",
      `repair observation identity does not match canonical turn ${turn.caller_turn_id}`,
    );
  }
}

function repairFixture(
  plan: ConversationalRepairPlan,
  decision: ConversationalRepairDecision,
): ConversationalRepairPcm {
  const selection = decision.selection;
  if (!selection) throw new Error("repair fixture requested for a no-repair decision");
  const fixture = plan.pcm_inventory.find((candidate) =>
    candidate.repair_pcm_id === selection.repair_pcm_id
    && candidate.stage_id === selection.stage_id
    && candidate.blocker_code === selection.blocker_code
  );
  if (!fixture
    || fixture.pcm_sha256 !== selection.pcm_sha256
    || fixture.byte_length !== selection.byte_length
    || fixture.sample_rate_hz !== selection.sample_rate_hz
    || fixture.channels !== selection.channels
    || fixture.encoding !== selection.encoding) {
    throw new Lc4RunnerFailure("scenario-invalid", "repair decision is not bound to its registered PCM fixture");
  }
  return fixture;
}

function playbackPcm(
  pcmId: string,
  fixture: Readonly<{
    pcm_sha256: string;
    byte_length: number;
    sample_rate_hz: 16_000 | 24_000;
    channels: 1;
    encoding: "pcm16le";
  }>,
  bytes: Uint8Array,
): Lc4PlaybackPcm {
  return Object.freeze({
    pcm_id: pcmId,
    pcm_sha256: fixture.pcm_sha256,
    byte_length: fixture.byte_length,
    sample_rate_hz: fixture.sample_rate_hz,
    channels: fixture.channels,
    encoding: fixture.encoding,
    // The transport receives a private copy. It cannot mutate registered bytes
    // or make the evidence hash disagree with later playback.
    bytes: bytes.slice(),
  });
}

function terminalForFailure(
  failure: Lc4RunnerFailure,
  repairCount: number,
): ConversationalRepairTerminalDisposition {
  return classifyConversationalRepairTerminal({
    scenario_invalid: failure.failureKind === "scenario-invalid",
    system_failure: failure.failureKind === "system-failure",
    harness_deadlock: false,
    transport_failure: failure.failureKind === "transport",
    mission_complete: false,
    absorbing_model_policy_attempt: false,
    repair_count: repairCount,
  });
}

function traceHash(entries: readonly TraceEntry[]): string {
  return sha256Hex(`${TRACE_DOMAIN}${canonicalJson(entries)}`);
}

/**
 * Development LC4 caller runner. Canonical opportunities remain the fixed
 * experimental horizon. A selected repair is an extra, preregistered caller
 * playback attached to that opportunity and never creates a new opportunity,
 * stage deadline, or recursive repair decision.
 */
export async function runLc4RepairEpisode(input: Lc4RepairRunnerInput): Promise<Lc4RepairRunnerResult> {
  const now = input.now ?? (() => new Date().toISOString());
  let state = createConversationalRepairState(input.plan, input.episode_id);
  const trace: TraceEntry[] = [];
  const journal: BenchmarkEventEnvelope[] = [];
  let canonicalExecuted = 0;
  let repairTurnsPlayed = 0;
  let failure: Lc4RunnerFailure | null = null;

  const record = (eventType: string, payload: JsonValue): void => {
    const envelope = journal.length === 0
      ? startEventChain({ run_id: input.run_id, observed_at: now(), event_type: eventType, payload })
      : appendEventEnvelope(journal[journal.length - 1]!, {
        observed_at: now(),
        event_type: eventType,
        payload,
      });
    journal.push(envelope);
  };

  record("lc4.repair_runner.started", {
    protocol_id: input.plan.protocol_id,
    episode_id: input.episode_id,
    plan_sha256: input.plan.plan_sha256,
    canonical_horizon_planned: input.canonical_turns.length,
  });

  try {
    assertCanonicalSchedule(input);

    for (let index = 0; index < input.canonical_turns.length; index += 1) {
      const turn = input.canonical_turns[index]!;
      const canonicalOrdinal = index + 1;
      assertPcmBytes(`canonical PCM ${turn.pcm.caller_pcm_id}`, turn.pcm, turn.pcm.bytes);
      record("lc4.caller_audio.verified", {
        kind: "canonical",
        caller_turn_id: turn.caller_turn_id,
        canonical_opportunity_id: turn.canonical_opportunity_id,
        canonical_ordinal: canonicalOrdinal,
        canonical_horizon_count: input.canonical_turns.length,
        advances_canonical_horizon: true,
        pcm_id: turn.pcm.caller_pcm_id,
        pcm_sha256: turn.pcm.pcm_sha256,
        byte_length: turn.pcm.byte_length,
        sample_rate_hz: turn.pcm.sample_rate_hz,
      });

      let canonicalResult: Lc4CallerPlaybackResult;
      try {
        canonicalResult = await input.play_caller_pcm(Object.freeze({
          kind: "canonical" as const,
          episode_id: input.episode_id,
          caller_turn_id: turn.caller_turn_id,
          canonical_opportunity_id: turn.canonical_opportunity_id,
          stage_id: turn.stage_id,
          canonical_ordinal: canonicalOrdinal,
          canonical_horizon_count: input.canonical_turns.length,
          advances_canonical_horizon: true as const,
          pcm: playbackPcm(turn.pcm.caller_pcm_id, turn.pcm, turn.pcm.bytes),
        }));
      } catch (error) {
        throw new Lc4RunnerFailure(
          "transport",
          `canonical caller playback failed at ${turn.caller_turn_id}`,
          { cause: error },
        );
      }
      canonicalExecuted += 1;
      record("lc4.caller_audio.played", {
        kind: "canonical",
        caller_turn_id: turn.caller_turn_id,
        canonical_opportunity_id: turn.canonical_opportunity_id,
        canonical_ordinal: canonicalOrdinal,
        advances_canonical_horizon: true,
        pcm_sha256: turn.pcm.pcm_sha256,
      });

      if (!canonicalResult || !canonicalResult.repair_observation) {
        throw new Lc4RunnerFailure(
          "scenario-invalid",
          `canonical caller turn ${turn.caller_turn_id} returned no repair observation`,
        );
      }
      const observation = canonicalResult.repair_observation;
      assertObservationIdentity(observation, input.episode_id, turn);

      let decisionResult;
      try {
        decisionResult = decideConversationalRepair({ plan: input.plan, state, observation });
      } catch (error) {
        throw new Lc4RunnerFailure(
          "scenario-invalid",
          `repair oracle rejected canonical turn ${turn.caller_turn_id}`,
          { cause: error },
        );
      }
      if (decisionResult.replayed) {
        throw new Lc4RunnerFailure("scenario-invalid", "canonical schedule replayed a caller-turn repair decision");
      }
      state = decisionResult.state;
      trace.push(Object.freeze({
        caller_turn_id: observation.caller_turn_id,
        canonical_opportunity_id: observation.canonical_opportunity_id,
        stage_id: observation.stage_id,
        deadline_reached: observation.deadline_reached,
        common_state_sha256: observation.common_state_sha256,
        listener_heard_semantics_sha256: observation.listener_heard_semantics_sha256,
        spoken_caller_fact_ids: Object.freeze([...observation.spoken_caller_fact_ids].sort()),
        visible_receipt_ids: Object.freeze([...observation.visible_receipt_ids].sort()),
        visible_worker_result_ids: Object.freeze([...observation.visible_worker_result_ids].sort()),
        unmet_blocker_codes: Object.freeze([...observation.unmet_blocker_codes].sort()),
        selection: decisionResult.decision.selection,
        no_repair_reason: decisionResult.decision.no_repair_reason,
      }));
      record("lc4.repair_oracle.decided", {
        caller_turn_id: turn.caller_turn_id,
        canonical_opportunity_id: turn.canonical_opportunity_id,
        canonical_ordinal: canonicalOrdinal,
        observation_sha256: decisionResult.decision.observation_sha256,
        decision_sha256: decisionResult.decision.decision_sha256,
        state_before_sha256: decisionResult.decision.state_before_sha256,
        state_after_sha256: state.state_sha256,
        selection: decisionResult.decision.selection,
        no_repair_reason: decisionResult.decision.no_repair_reason,
      });

      if (!decisionResult.decision.selection) continue;
      const fixture = repairFixture(input.plan, decisionResult.decision);
      let repairBytes: Uint8Array;
      try {
        repairBytes = await input.load_repair_pcm(fixture);
      } catch (error) {
        throw new Lc4RunnerFailure(
          "system-failure",
          `registered repair PCM ${fixture.repair_pcm_id} could not be loaded`,
          { cause: error },
        );
      }
      assertPcmBytes(`repair PCM ${fixture.repair_pcm_id}`, fixture, repairBytes);
      record("lc4.caller_audio.verified", {
        kind: "repair",
        caller_turn_id: turn.caller_turn_id,
        canonical_opportunity_id: turn.canonical_opportunity_id,
        canonical_ordinal: canonicalOrdinal,
        canonical_horizon_count: input.canonical_turns.length,
        advances_canonical_horizon: false,
        blocker_code: fixture.blocker_code,
        pcm_id: fixture.repair_pcm_id,
        pcm_sha256: fixture.pcm_sha256,
        source_text_sha256: fixture.source_text_sha256,
        voice_id: fixture.voice_id,
        byte_length: fixture.byte_length,
        sample_rate_hz: fixture.sample_rate_hz,
      });

      let repairResult: Lc4CallerPlaybackResult;
      try {
        repairResult = await input.play_caller_pcm(Object.freeze({
          kind: "repair" as const,
          episode_id: input.episode_id,
          caller_turn_id: turn.caller_turn_id,
          canonical_opportunity_id: turn.canonical_opportunity_id,
          stage_id: turn.stage_id,
          blocker_code: fixture.blocker_code,
          canonical_ordinal: canonicalOrdinal,
          canonical_horizon_count: input.canonical_turns.length,
          advances_canonical_horizon: false as const,
          source_text_sha256: fixture.source_text_sha256,
          voice_id: fixture.voice_id,
          pcm: playbackPcm(fixture.repair_pcm_id, fixture, repairBytes),
        }));
      } catch (error) {
        throw new Lc4RunnerFailure(
          "transport",
          `repair caller playback failed at ${turn.caller_turn_id}`,
          { cause: error },
        );
      }
      if (!repairResult || repairResult.repair_observation !== null) {
        throw new Lc4RunnerFailure(
          "scenario-invalid",
          "repair playback attempted to create a recursive repair horizon",
        );
      }
      repairTurnsPlayed += 1;
      record("lc4.caller_audio.played", {
        kind: "repair",
        caller_turn_id: turn.caller_turn_id,
        canonical_opportunity_id: turn.canonical_opportunity_id,
        canonical_ordinal: canonicalOrdinal,
        canonical_horizon_count: input.canonical_turns.length,
        advances_canonical_horizon: false,
        blocker_code: fixture.blocker_code,
        pcm_sha256: fixture.pcm_sha256,
      });
    }
  } catch (error) {
    failure = error instanceof Lc4RunnerFailure
      ? error
      : new Lc4RunnerFailure("system-failure", "LC4 repair runner failed unexpectedly", { cause: error });
    record("lc4.repair_runner.failed", {
      failure_kind: failure.failureKind,
      message: failure.message,
      canonical_horizon_planned: input.canonical_turns.length,
      canonical_horizon_executed: canonicalExecuted,
      repair_turns_played: repairTurnsPlayed,
    });
  }

  let terminal: ConversationalRepairTerminalDisposition;
  if (failure) {
    terminal = terminalForFailure(failure, state.repair_count);
  } else {
    try {
      const base = await input.terminal_evidence();
      terminal = classifyConversationalRepairTerminal({ ...base, repair_count: state.repair_count });
    } catch (error) {
      failure = new Lc4RunnerFailure(
        "system-failure",
        "LC4 terminal evidence could not be classified",
        { cause: error },
      );
      terminal = terminalForFailure(failure, state.repair_count);
    }
  }

  const armBlindTraceSha256 = traceHash(trace);
  record("lc4.repair_runner.terminal", {
    terminal_class: terminal.terminal_class,
    terminal_sha256: terminal.terminal_sha256,
    failure_message: failure?.message ?? null,
    canonical_horizon_planned: input.canonical_turns.length,
    canonical_horizon_executed: canonicalExecuted,
    repair_turns_played: repairTurnsPlayed,
    repair_count: state.repair_count,
    arm_blind_repair_trace_sha256: armBlindTraceSha256,
  });

  return Object.freeze({
    schema_version: 1 as const,
    protocol_id: "HACC-LC4-v1" as const,
    run_id: input.run_id,
    episode_id: input.episode_id,
    plan_sha256: input.plan.plan_sha256,
    canonical_horizon_planned: input.canonical_turns.length,
    canonical_horizon_executed: canonicalExecuted,
    repair_turns_played: repairTurnsPlayed,
    canonical_opportunity_ids: Object.freeze(input.canonical_turns.map((turn) => turn.canonical_opportunity_id)),
    repair_state: state,
    arm_blind_repair_trace_sha256: armBlindTraceSha256,
    terminal,
    failure_message: failure?.message ?? null,
    journal: Object.freeze([...journal]),
  });
}
