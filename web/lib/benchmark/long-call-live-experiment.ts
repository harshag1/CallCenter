import { canonicalJson, sha256Hex } from "./artifacts";
import { assertValidBudgetLedger, createBudgetLedger, reserveBudget, type BudgetLedger } from "./budget";
import { exactMcNemarTwoSided } from "./usefulness-scoring";
import {
  USEFULNESS_DEVELOPMENT_SUITE_SHA256,
  USEFULNESS_DEVELOPMENT_TASKS,
  type UsefulnessDevelopmentTask,
} from "./usefulness-task-suite";
import {
  LIVE_STS_PROVIDER_SPECS,
  type LiveStsProvider,
} from "./live-sts-development-experiment";
import type { PublicKernelTranscript } from "./kernel-transcript";
import type { ToolWorldState } from "./tool-world";

export const LONG_CALL_PROTOCOL_ID = "HACC-LC3-v1" as const;
export const LONG_CALL_EXPERIMENT_SEED = "hacc-lc3-20260721-v1";
export const LONG_CALL_TTS_VOICES = Object.freeze(["Samantha", "Daniel", "Karen"] as const);
export const LONG_CALL_CONDITIONS = Object.freeze(["raw-memory", "full-harness"] as const);
export const LONG_CALL_PROVIDERS = Object.freeze(["openai", "gemini", "xai"] as const);
export const LONG_CALL_FAMILIES = Object.freeze(["museum", "campus", "water"] as const);
export const LONG_CALL_TURNS_PER_EPISODE = 20 as const;
export const LONG_CALL_SCHEDULED_PAIRS = 27 as const;
export const LONG_CALL_SCHEDULED_EPISODES = 54 as const;
export const LONG_CALL_SCHEDULED_CALLER_TURNS = 1_080 as const;
export const LONG_CALL_MAXIMUM_USD_PER_EPISODE = "5" as const;
export const LONG_CALL_MAXIMUM_AGGREGATE_USD = "270" as const;

export type LongCallTtsVoice = typeof LONG_CALL_TTS_VOICES[number];
export type LongCallCondition = typeof LONG_CALL_CONDITIONS[number];
export type LongCallFamily = typeof LONG_CALL_FAMILIES[number];

export type LongCallPair = Readonly<{
  ordinal: number;
  pairId: string;
  provider: LiveStsProvider;
  family: LongCallFamily;
  ttsVoice: LongCallTtsVoice;
  armOrder: readonly [LongCallCondition, LongCallCondition];
}>;

export type LongCallCell = Readonly<{
  ordinal: number;
  pairOrdinal: number;
  pairId: string;
  runId: string;
  provider: LiveStsProvider;
  model: string;
  providerVoice: string;
  sampleRateHz: 16_000 | 24_000;
  family: LongCallFamily;
  ttsVoice: LongCallTtsVoice;
  condition: LongCallCondition;
  turnsPlanned: 20;
}>;

export type LongCallSummary = Readonly<{
  schemaVersion: 1;
  protocolId: typeof LONG_CALL_PROTOCOL_ID;
  runId: string;
  pairId: string;
  provider: LiveStsProvider;
  model: string;
  family: LongCallFamily;
  ttsVoice: LongCallTtsVoice;
  condition: LongCallCondition;
  status: string;
  callerScheduleStatus: string | null;
  turnsPlanned: number;
  turnsSent: number;
  outputAudioTurns: number;
  transportTerminal: boolean;
  worldOutcomePass: boolean;
  modelIntegrityPass: boolean;
  systemIntegrityPass: boolean;
  audioSemanticPass: boolean;
  asrReceiptsSha256: string | null;
  strictPass: boolean;
  estimatedCostUsd: number | null;
  artifactManifestSha256: string;
  failureClass: "transport" | "model" | "world" | "system" | "audio" | null;
}>;

export function longUsefulnessTask(family: LongCallFamily): UsefulnessDevelopmentTask {
  const task = USEFULNESS_DEVELOPMENT_TASKS.find((candidate) =>
    candidate.family === family && candidate.complexity_band === "long"
  );
  if (!task) throw new Error(`missing long usefulness task for ${family}`);
  if (task.scenario.caller.turns.length !== LONG_CALL_TURNS_PER_EPISODE) {
    throw new Error(`${family} long task must contain exactly ${LONG_CALL_TURNS_PER_EPISODE} turns`);
  }
  return task;
}

function armOrder(pairId: string): readonly [LongCallCondition, LongCallCondition] {
  const rawFirst = Number.parseInt(
    sha256Hex(`${LONG_CALL_EXPERIMENT_SEED}\n${pairId}\narm-order`).slice(-2),
    16,
  ) % 2 === 0;
  return rawFirst
    ? Object.freeze(["raw-memory", "full-harness"] as const)
    : Object.freeze(["full-harness", "raw-memory"] as const);
}

export function createLongCallPairs(): readonly LongCallPair[] {
  let ordinal = 0;
  const pairs: LongCallPair[] = [];
  for (const provider of LONG_CALL_PROVIDERS) {
    for (const family of LONG_CALL_FAMILIES) {
      for (const ttsVoice of LONG_CALL_TTS_VOICES) {
        const pairId = `lc3-${provider}-${family}-${ttsVoice.toLowerCase()}`;
        pairs.push(Object.freeze({
          ordinal: ++ordinal,
          pairId,
          provider,
          family,
          ttsVoice,
          armOrder: armOrder(pairId),
        }));
      }
    }
  }
  return Object.freeze(pairs);
}

export function createLongCallCells(): readonly LongCallCell[] {
  let ordinal = 0;
  return Object.freeze(createLongCallPairs().flatMap((pair) => {
    const spec = LIVE_STS_PROVIDER_SPECS[pair.provider];
    return pair.armOrder.map((condition) => Object.freeze({
      ordinal: ++ordinal,
      pairOrdinal: pair.ordinal,
      pairId: pair.pairId,
      runId: `${pair.pairId}-${condition}`,
      provider: pair.provider,
      model: spec.model,
      providerVoice: spec.voice,
      sampleRateHz: spec.sampleRateHz,
      family: pair.family,
      ttsVoice: pair.ttsVoice,
      condition,
      turnsPlanned: LONG_CALL_TURNS_PER_EPISODE,
    }));
  }));
}

export function longCallScheduleArtifact() {
  const pairs = createLongCallPairs();
  const cells = createLongCallCells();
  const body = Object.freeze({
    schemaVersion: 1 as const,
    protocolId: LONG_CALL_PROTOCOL_ID,
    seed: LONG_CALL_EXPERIMENT_SEED,
    evidenceClass: "paired-live-production-api-benchmark" as const,
    primaryEndpoint: "strict task pass: terminal transport + 20/20 caller turns + 20/20 audible outputs + no rejected or blocked-invalid model attempt + independent ASR semantic correctness + world success + every safety invariant",
    estimand: "within-provider paired risk difference of HACC full-harness minus native raw-memory",
    suiteSha256: USEFULNESS_DEVELOPMENT_SUITE_SHA256,
    providers: LIVE_STS_PROVIDER_SPECS,
    ttsVoices: LONG_CALL_TTS_VOICES,
    pairs,
    cells,
    scheduledPairs: pairs.length,
    scheduledEpisodes: cells.length,
    scheduledCallerTurns: cells.length * LONG_CALL_TURNS_PER_EPISODE,
    maximumUsdPerEpisode: LONG_CALL_MAXIMUM_USD_PER_EPISODE,
    maximumAggregateUsd: LONG_CALL_MAXIMUM_AGGREGATE_USD,
    retryPolicy: "no paid episode retry" as const,
    executionOrder: "arms adjacent within pair; pairs may execute concurrently" as const,
  });
  return Object.freeze({
    ...body,
    scheduleSha256: sha256Hex(`harshas-amazing-call-center/long-call-schedule/v1\n${canonicalJson(body)}`),
  });
}

/** Reserve the entire frozen schedule before any provider socket can open. */
export function createLongCallBudgetLedger(createdAt: string): BudgetLedger {
  let ledger = createBudgetLedger({
    authorization_ceiling_usd: LONG_CALL_MAXIMUM_AGGREGATE_USD,
    scheduling_stop_usd: LONG_CALL_MAXIMUM_AGGREGATE_USD,
  });
  for (const cell of createLongCallCells()) {
    ledger = reserveBudget(ledger, {
      reservation_id: `${cell.runId}-aggregate-reservation`,
      provider: cell.provider,
      model: cell.model,
      run_id: cell.runId,
      created_at: createdAt,
      maximum_usd: LONG_CALL_MAXIMUM_USD_PER_EPISODE,
    }).ledger;
  }
  return ledger;
}

export function assertLongCallBudgetLedgerMatchesSchedule(ledger: BudgetLedger): void {
  assertValidBudgetLedger(ledger);
  if (
    ledger.authorization_ceiling_micro_usd !== 270_000_000
    || ledger.scheduling_stop_micro_usd !== 270_000_000
  ) throw new Error("long-call ledger must retain the frozen $270 aggregate cap");
  const cells = createLongCallCells();
  if (ledger.reservations.length !== cells.length) throw new Error("long-call ledger must contain exactly 54 reservations");
  const byId = new Map(ledger.reservations.map((reservation) => [reservation.reservation_id, reservation]));
  for (const cell of cells) {
    const reservation = byId.get(`${cell.runId}-aggregate-reservation`);
    if (
      !reservation
      || reservation.provider !== cell.provider
      || reservation.model !== cell.model
      || reservation.run_id !== cell.runId
      || reservation.maximum_micro_usd !== 5_000_000
      || reservation.status === "released"
    ) throw new Error(`long-call ledger reservation mismatch for ${cell.runId}`);
  }
}

export function classifyLongCallFailure(input: Pick<LongCallSummary,
  "transportTerminal" | "modelIntegrityPass" | "worldOutcomePass" | "systemIntegrityPass" | "audioSemanticPass"
>): LongCallSummary["failureClass"] {
  if (!input.transportTerminal) return "transport";
  if (!input.modelIntegrityPass) return "model";
  if (!input.systemIntegrityPass) return "system";
  if (!input.worldOutcomePass) return "world";
  if (!input.audioSemanticPass) return "audio";
  return null;
}

export function isStrictLongCallPass(input: Pick<LongCallSummary,
  "transportTerminal" | "modelIntegrityPass" | "worldOutcomePass" | "systemIntegrityPass" | "audioSemanticPass" | "turnsPlanned" | "turnsSent" | "outputAudioTurns"
>): boolean {
  return input.transportTerminal
    && input.modelIntegrityPass
    && input.worldOutcomePass
    && input.systemIntegrityPass
    && input.audioSemanticPass
    && input.turnsPlanned === LONG_CALL_TURNS_PER_EPISODE
    && input.turnsSent === LONG_CALL_TURNS_PER_EPISODE
    && input.outputAudioTurns === LONG_CALL_TURNS_PER_EPISODE;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Scores what the model attempted, separately from whether HACC contained the
 * attempt. Expected provider/tool faults append a non-rejected ToolWorld
 * receipt; gateway failures with no such receipt are blocked invalid model
 * actions and fail closed.
 */
export function evaluateLongCallModelIntegrity(
  world: Pick<ToolWorldState, "receipts">,
  transcript: PublicKernelTranscript,
): boolean {
  if (world.receipts.some((receipt) =>
    receipt.status === "rejected"
    || receipt.prerequisite_evidence.some((evidence) => !evidence.passed)
  )) return false;

  for (const entry of transcript.entries) {
    if (entry.operation !== "invoke") continue;
    const payload = record(entry.payload);
    const outcome = record(payload?.outcome);
    if (outcome?.result_class !== "failure") continue;
    const input = record(payload?.input);
    const expectedFaultReceipt = typeof input?.action === "string"
      && typeof input.turn === "number"
      && world.receipts.some((receipt) =>
        receipt.tool === input.action
        && receipt.turn === input.turn
        && (receipt.status === "failed_before_commit" || receipt.status === "committed_after_error")
      );
    if (!expectedFaultReceipt) return false;
  }
  return true;
}

export function scoreLongCallExperiment(summaries: readonly LongCallSummary[]) {
  const cells = createLongCallCells();
  const byRun = new Map<string, LongCallSummary>();
  for (const summary of summaries) {
    if (byRun.has(summary.runId)) throw new Error(`duplicate summary ${summary.runId}`);
    byRun.set(summary.runId, summary);
  }
  const missing = cells.filter((cell) => !byRun.has(cell.runId)).map((cell) => cell.runId);
  const unexpected = summaries.filter((summary) => !cells.some((cell) => cell.runId === summary.runId)).map((summary) => summary.runId);
  if (missing.length || unexpected.length) {
    throw new Error(`incomplete long-call result set: ${canonicalJson({ missing, unexpected })}`);
  }
  const ordered = cells.map((cell) => {
    const summary = byRun.get(cell.runId)!;
    for (const key of ["pairId", "provider", "model", "family", "ttsVoice", "condition"] as const) {
      if (summary[key] !== cell[key]) throw new Error(`${cell.runId} mismatches ${key}`);
    }
    if (summary.strictPass !== isStrictLongCallPass(summary)) throw new Error(`${cell.runId} has inconsistent strictPass`);
    if (summary.failureClass !== classifyLongCallFailure(summary)) throw new Error(`${cell.runId} has inconsistent failureClass`);
    return summary;
  });
  const pairResults = createLongCallPairs().map((pair) => {
    const raw = ordered.find((summary) => summary.pairId === pair.pairId && summary.condition === "raw-memory")!;
    const harness = ordered.find((summary) => summary.pairId === pair.pairId && summary.condition === "full-harness")!;
    return Object.freeze({
      pairId: pair.pairId,
      provider: pair.provider,
      family: pair.family,
      ttsVoice: pair.ttsVoice,
      rawPass: raw.strictPass,
      harnessPass: harness.strictPass,
      outcome: raw.strictPass === harness.strictPass
        ? (raw.strictPass ? "both_pass" : "neither_pass")
        : harness.strictPass ? "harness_only" : "raw_only",
    });
  });
  const providerEffects = LONG_CALL_PROVIDERS.map((provider) => {
    const providerPairs = pairResults.filter((pair) => pair.provider === provider);
    const rawPasses = providerPairs.filter((pair) => pair.rawPass).length;
    const harnessPasses = providerPairs.filter((pair) => pair.harnessPass).length;
    const harnessOnly = providerPairs.filter((pair) => pair.outcome === "harness_only").length;
    const rawOnly = providerPairs.filter((pair) => pair.outcome === "raw_only").length;
    const providerRuns = ordered.filter((run) => run.provider === provider);
    const count = (condition: LongCallCondition, field: "transportTerminal" | "modelIntegrityPass" | "worldOutcomePass" | "systemIntegrityPass" | "audioSemanticPass") =>
      providerRuns.filter((run) => run.condition === condition && run[field]).length;
    return Object.freeze({
      provider,
      model: LIVE_STS_PROVIDER_SPECS[provider].model,
      scheduledPairs: providerPairs.length,
      rawPasses,
      harnessPasses,
      pairedRiskDifference: (harnessPasses - rawPasses) / providerPairs.length,
      harnessOnly,
      rawOnly,
      exactMcNemarTwoSidedP: exactMcNemarTwoSided(harnessOnly, rawOnly),
      transport: Object.freeze({ raw: count("raw-memory", "transportTerminal"), harness: count("full-harness", "transportTerminal") }),
      modelIntegrity: Object.freeze({ raw: count("raw-memory", "modelIntegrityPass"), harness: count("full-harness", "modelIntegrityPass") }),
      world: Object.freeze({ raw: count("raw-memory", "worldOutcomePass"), harness: count("full-harness", "worldOutcomePass") }),
      system: Object.freeze({ raw: count("raw-memory", "systemIntegrityPass"), harness: count("full-harness", "systemIntegrityPass") }),
      audio: Object.freeze({ raw: count("raw-memory", "audioSemanticPass"), harness: count("full-harness", "audioSemanticPass") }),
    });
  });
  const body = Object.freeze({
    schemaVersion: 1 as const,
    protocolId: LONG_CALL_PROTOCOL_ID,
    scheduledEpisodes: cells.length,
    observedEpisodes: ordered.length,
    scheduledPairs: pairResults.length,
    scheduledCallerTurns: cells.length * LONG_CALL_TURNS_PER_EPISODE,
    completedVoiceToVoiceInteractions: ordered.reduce((total, run) => total + Math.min(run.turnsSent, run.outputAudioTurns), 0),
    primaryEndpoint: "strict task pass",
    providerEffects: Object.freeze(providerEffects),
    pairResults: Object.freeze(pairResults),
    transportFailures: ordered.filter((run) => run.failureClass === "transport").length,
    modelFailures: ordered.filter((run) => run.failureClass === "model").length,
    worldFailures: ordered.filter((run) => run.failureClass === "world").length,
    systemFailures: ordered.filter((run) => run.failureClass === "system").length,
    estimatedCostUsd: ordered.reduce((total, run) => total + (run.estimatedCostUsd ?? 0), 0),
  });
  return Object.freeze({
    ...body,
    resultSha256: sha256Hex(`harshas-amazing-call-center/long-call-result/v1\n${canonicalJson(body)}`),
  });
}
