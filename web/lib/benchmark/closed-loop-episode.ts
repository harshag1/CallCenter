import {
  canonicalJson,
  sha256Hex,
  verifyEventChain,
  type BenchmarkEventEnvelope,
} from "./artifacts";
import {
  createDeterministicCallerWorldScheduler,
  observeCallerWorld,
  type CallerTurnSelection,
  type CallerWorldObservation,
  type CallerWorldSchedulePlan,
  type ScheduledCallerOpportunity,
  type TrustedCallerWorldEvent,
} from "./caller-world-scheduler";
import {
  ToolWorldStateSchema,
  type ToolWorldState,
} from "./tool-world";

const SCHEDULED_EPISODE_DOMAIN = "harshas-amazing-call-center/scheduled-episode/v1\n";
const EXECUTION_RECORD_DOMAIN = "harshas-amazing-call-center/closed-loop-turn/v1\n";
const SHA256 = /^[a-f0-9]{64}$/;

export type ScheduledEpisodeCondition = "raw-memory-v1" | "full-harness-v1";

export type ScheduledEpisodeRecord = Readonly<{
  schema_version: 1;
  protocol_id: "HACC-VTR-v1";
  episode_id: string;
  pair_id: string;
  provider: string;
  model: string;
  condition: ScheduledEpisodeCondition;
  task_family: string;
  task_id: string;
  task_version: string;
  complexity_band: "short" | "medium" | "long";
  schedule_sha256: string;
  scheduled_at: string;
  record_sha256: string;
}>;

export type ClosedLoopTurnExecution = Readonly<{
  ordinal: number;
  selected_at: string;
  committed_at: string;
  selection: CallerTurnSelection;
  opportunities: readonly ScheduledCallerOpportunity[];
  observation_before: CallerWorldObservation;
  observation_after: CallerWorldObservation;
  world_before_sha256: string;
  world_after_sha256: string;
  execution_sha256: string;
}>;

export type ClosedLoopEpisodeStatus =
  | "completed"
  | "caller_blocked"
  | "executor_error"
  | "turn_limit_exceeded";

export type ClosedLoopEpisodeResult = Readonly<{
  schema_version: 1;
  protocol_id: "HACC-VTR-v1";
  scheduled: ScheduledEpisodeRecord;
  status: ClosedLoopEpisodeStatus;
  turns: readonly ClosedLoopTurnExecution[];
  caller_world_events: readonly TrustedCallerWorldEvent[];
  caller_evidence: readonly BenchmarkEventEnvelope[];
  final_world: ToolWorldState;
  error: Readonly<{ class: string; message_sha256: string }> | null;
}>;

export type ClosedLoopTurnExecutorInput = Readonly<{
  scheduled: ScheduledEpisodeRecord;
  ordinal: number;
  selection: CallerTurnSelection;
  opportunities: readonly ScheduledCallerOpportunity[];
  observation: CallerWorldObservation;
  world: ToolWorldState;
}>;

export type ClosedLoopTurnExecutorOutput = Readonly<{
  world: ToolWorldState;
}>;

export type ClosedLoopEpisodeInput = Readonly<{
  episode: Omit<ScheduledEpisodeRecord, "schema_version" | "protocol_id" | "schedule_sha256" | "record_sha256">;
  caller_plan: CallerWorldSchedulePlan;
  initial_world: ToolWorldState;
  max_turns: number;
  on_scheduled(record: ScheduledEpisodeRecord): void | Promise<void>;
  execute_turn(input: ClosedLoopTurnExecutorInput): ClosedLoopTurnExecutorOutput | Promise<ClosedLoopTurnExecutorOutput>;
  now?: () => string;
}>;

export type ClosedLoopReplayResult = Readonly<{
  valid: boolean;
  errors: readonly string[];
  replayed_turns: number;
  schedule_sha256: string;
  caller_evidence_chain_head: string | null;
}>;

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 512) {
    throw new Error(`${label} must be a non-empty string of at most 512 characters`);
  }
}

function assertIso(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`);
}

function worldSha256(world: ToolWorldState): string {
  return sha256Hex(`harshas-amazing-call-center/tool-world-snapshot/v1\n${canonicalJson(world)}`);
}

function executionSha256(
  ordinal: number,
  selectedAt: string,
  committedAt: string,
  selection: CallerTurnSelection,
  observationBefore: CallerWorldObservation,
  observationAfter: CallerWorldObservation,
  worldBeforeSha256: string,
  worldAfterSha256: string,
): string {
  return sha256Hex(`${EXECUTION_RECORD_DOMAIN}${canonicalJson({
    ordinal,
    selected_at: selectedAt,
    committed_at: committedAt,
    selection,
    observation_before: observationBefore,
    observation_after: observationAfter,
    world_before_sha256: worldBeforeSha256,
    world_after_sha256: worldAfterSha256,
  })}`);
}

function createScheduledRecord(
  episode: ClosedLoopEpisodeInput["episode"],
  scheduleSha256: string,
): ScheduledEpisodeRecord {
  for (const [label, value] of Object.entries({
    episode_id: episode.episode_id,
    pair_id: episode.pair_id,
    provider: episode.provider,
    model: episode.model,
    task_family: episode.task_family,
    task_id: episode.task_id,
    task_version: episode.task_version,
  })) assertNonEmpty(value, label);
  assertIso(episode.scheduled_at, "scheduled_at");
  if (!SHA256.test(scheduleSha256)) throw new Error("schedule_sha256 must be lowercase SHA-256");
  const body = Object.freeze({
    schema_version: 1 as const,
    protocol_id: "HACC-VTR-v1" as const,
    ...episode,
    schedule_sha256: scheduleSha256,
  });
  return Object.freeze({
    ...body,
    record_sha256: sha256Hex(`${SCHEDULED_EPISODE_DOMAIN}${canonicalJson(body)}`),
  });
}

function errorRecord(error: unknown): ClosedLoopEpisodeResult["error"] {
  const message = error instanceof Error ? error.message : String(error);
  return Object.freeze({
    class: error instanceof Error ? error.name : "NonErrorThrow",
    message_sha256: sha256Hex(message),
  });
}

/**
 * Execute one condition-blind caller policy around a stateful turn executor.
 * The scheduled record is durably handed off before the first executor call,
 * so provider/connect failures cannot disappear from the ITT denominator.
 */
export async function runClosedLoopEpisode(input: ClosedLoopEpisodeInput): Promise<ClosedLoopEpisodeResult> {
  if (!Number.isSafeInteger(input.max_turns) || input.max_turns < 1) {
    throw new Error("max_turns must be a positive safe integer");
  }
  const now = input.now ?? (() => new Date().toISOString());
  const scheduler = createDeterministicCallerWorldScheduler(input.caller_plan);
  if (scheduler.initialState.run_id !== input.episode.episode_id) {
    throw new Error("caller plan run_id must equal the scheduled episode_id");
  }
  const scheduled = createScheduledRecord(input.episode, scheduler.initialState.schedule_sha256);
  await input.on_scheduled(scheduled);

  let state = scheduler.initialState;
  let world = ToolWorldStateSchema.parse(structuredClone(input.initial_world));
  const turns: ClosedLoopTurnExecution[] = [];
  const callerWorldEvents: TrustedCallerWorldEvent[] = [];

  while (true) {
    const observationBefore = observeCallerWorld(world, input.caller_plan.observable_world_fact_keys);
    const selectedAt = now();
    const selected = scheduler.selectNext({ state, observation: observationBefore, observed_at: selectedAt });
    state = selected.state;
    if (selected.status === "complete") {
      return Object.freeze({
        schema_version: 1,
        protocol_id: "HACC-VTR-v1",
        scheduled,
        status: "completed",
        turns: Object.freeze(turns),
        caller_world_events: Object.freeze(callerWorldEvents),
        caller_evidence: state.evidence,
        final_world: world,
        error: null,
      });
    }
    if (selected.status === "blocked") {
      return Object.freeze({
        schema_version: 1,
        protocol_id: "HACC-VTR-v1",
        scheduled,
        status: "caller_blocked",
        turns: Object.freeze(turns),
        caller_world_events: Object.freeze(callerWorldEvents),
        caller_evidence: state.evidence,
        final_world: world,
        error: Object.freeze({
          class: "CallerPolicyBlocked",
          message_sha256: sha256Hex(`${selected.stage_id}\n${selected.unmet.join("\n")}`),
        }),
      });
    }
    if (turns.length >= input.max_turns) {
      return Object.freeze({
        schema_version: 1,
        protocol_id: "HACC-VTR-v1",
        scheduled,
        status: "turn_limit_exceeded",
        turns: Object.freeze(turns),
        caller_world_events: Object.freeze(callerWorldEvents),
        caller_evidence: state.evidence,
        final_world: world,
        error: Object.freeze({ class: "TurnLimitExceeded", message_sha256: sha256Hex(String(input.max_turns)) }),
      });
    }

    const ordinal = turns.length + 1;
    const worldBeforeSha256 = worldSha256(world);
    let output: ClosedLoopTurnExecutorOutput;
    try {
      output = await input.execute_turn(Object.freeze({
        scheduled,
        ordinal,
        selection: selected.selection,
        opportunities: selected.opportunities,
        observation: observationBefore,
        world,
      }));
    } catch (error) {
      return Object.freeze({
        schema_version: 1,
        protocol_id: "HACC-VTR-v1",
        scheduled,
        status: "executor_error",
        turns: Object.freeze(turns),
        caller_world_events: Object.freeze(callerWorldEvents),
        caller_evidence: state.evidence,
        final_world: world,
        error: errorRecord(error),
      });
    }
    world = ToolWorldStateSchema.parse(structuredClone(output.world));
    const observationAfter = observeCallerWorld(world, input.caller_plan.observable_world_fact_keys);
    const committedAt = now();
    const committed = scheduler.commitTurn({
      state,
      selection_id: selected.selection.selection_id,
      observation: observationAfter,
      observed_at: committedAt,
    });
    state = committed.state;
    callerWorldEvents.push(...committed.world_events);
    const worldAfterSha256 = worldSha256(world);
    turns.push(Object.freeze({
      ordinal,
      selected_at: selectedAt,
      committed_at: committedAt,
      selection: selected.selection,
      opportunities: Object.freeze([...selected.opportunities, ...committed.opportunities]),
      observation_before: observationBefore,
      observation_after: observationAfter,
      world_before_sha256: worldBeforeSha256,
      world_after_sha256: worldAfterSha256,
      execution_sha256: executionSha256(
        ordinal,
        selectedAt,
        committedAt,
        selected.selection,
        observationBefore,
        observationAfter,
        worldBeforeSha256,
        worldAfterSha256,
      ),
    }));
  }
}

/** Independently replay caller selection and commit decisions from persisted observations. */
export function replayClosedLoopEpisode(
  plan: CallerWorldSchedulePlan,
  result: ClosedLoopEpisodeResult,
): ClosedLoopReplayResult {
  const errors: string[] = [];
  let scheduler: ReturnType<typeof createDeterministicCallerWorldScheduler>;
  try {
    scheduler = createDeterministicCallerWorldScheduler(plan);
  } catch (error) {
    return Object.freeze({
      valid: false,
      errors: Object.freeze([error instanceof Error ? error.message : String(error)]),
      replayed_turns: 0,
      schedule_sha256: "",
      caller_evidence_chain_head: null,
    });
  }
  if (scheduler.initialState.schedule_sha256 !== result.scheduled.schedule_sha256) {
    errors.push("scheduled record uses a different caller schedule hash");
  }
  if (result.scheduled.episode_id !== plan.run_id) errors.push("episode_id differs from caller plan run_id");
  let state = scheduler.initialState;
  let replayedTurns = 0;
  for (const turn of result.turns) {
    try {
      const selected = scheduler.selectNext({
        state,
        observation: turn.observation_before,
        observed_at: turn.selected_at,
      });
      if (selected.status !== "selected") {
        errors.push(`turn ${turn.ordinal} replay did not select a turn`);
        break;
      }
      if (canonicalJson(selected.selection) !== canonicalJson(turn.selection)) {
        errors.push(`turn ${turn.ordinal} selection differs from deterministic replay`);
      }
      state = selected.state;
      const expectedExecutionSha256 = executionSha256(
        turn.ordinal,
        turn.selected_at,
        turn.committed_at,
        turn.selection,
        turn.observation_before,
        turn.observation_after,
        turn.world_before_sha256,
        turn.world_after_sha256,
      );
      if (expectedExecutionSha256 !== turn.execution_sha256) {
        errors.push(`turn ${turn.ordinal} execution record hash is invalid`);
      }
      const committed = scheduler.commitTurn({
        state,
        selection_id: selected.selection.selection_id,
        observation: turn.observation_after,
        observed_at: turn.committed_at,
      });
      state = committed.state;
      replayedTurns += 1;
    } catch (error) {
      errors.push(`turn ${turn.ordinal} replay failed: ${error instanceof Error ? error.message : String(error)}`);
      break;
    }
  }
  if (result.status === "completed") {
    try {
      const terminal = scheduler.selectNext({
        state,
        observation: result.turns.at(-1)?.observation_after
          ?? observeCallerWorld(result.final_world, plan.observable_world_fact_keys),
        observed_at: result.scheduled.scheduled_at,
      });
      if (terminal.status !== "complete") errors.push("completed episode does not replay to caller-policy completion");
    } catch (error) {
      errors.push(`terminal replay failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const evidence = verifyEventChain(result.caller_evidence);
  if (!evidence.valid) errors.push(`caller evidence chain is invalid: ${evidence.errors.join("; ")}`);
  if (canonicalJson(state.evidence) !== canonicalJson(result.caller_evidence)) {
    errors.push("caller evidence differs from independently replayed evidence");
  }
  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
    replayed_turns: replayedTurns,
    schedule_sha256: scheduler.initialState.schedule_sha256,
    caller_evidence_chain_head: evidence.chain_head || null,
  });
}
