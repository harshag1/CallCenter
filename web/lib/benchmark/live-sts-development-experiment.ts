import { canonicalJson, sha256Hex } from "./artifacts";
import type { BenchmarkConditionId } from "./condition-compiler";

export const LIVE_STS_EXPERIMENT_ID = "live-sts-long-flow-development-v1";
export const LIVE_STS_EXPERIMENT_SEED = "hacc-live-sts-20260720-v1";
export const LIVE_STS_TURNS_PER_SESSION = 32;

export const LIVE_STS_PROVIDER_SPECS = Object.freeze({
  openai: Object.freeze({
    provider: "openai" as const,
    model: "gpt-realtime-2.1",
    voice: "marin",
    sampleRateHz: 24_000,
  }),
  gemini: Object.freeze({
    provider: "gemini" as const,
    model: "gemini-3.1-flash-live-preview",
    voice: "Aoede",
    sampleRateHz: 16_000,
  }),
  xai: Object.freeze({
    provider: "xai" as const,
    model: "grok-voice-think-fast-1.0",
    voice: "ara",
    sampleRateHz: 24_000,
  }),
});

export type LiveStsProvider = keyof typeof LIVE_STS_PROVIDER_SPECS;
export type LiveStsFamily = "field-service-escalation" | "travel-disruption";
export type LiveStsCondition = Extract<BenchmarkConditionId, "raw-full" | "full-harness">;

export type LiveStsPair = Readonly<{
  pairId: string;
  provider: LiveStsProvider;
  family: LiveStsFamily;
  replicate: number;
  armOrder: readonly [LiveStsCondition, LiveStsCondition];
}>;

export type LiveStsCell = Readonly<{
  ordinal: number;
  pairId: string;
  runId: string;
  provider: LiveStsProvider;
  family: LiveStsFamily;
  replicate: number;
  condition: LiveStsCondition;
}>;

const PAIR_COUNTS: Readonly<Record<LiveStsProvider, Readonly<Record<LiveStsFamily, number>>>> = Object.freeze({
  openai: Object.freeze({ "field-service-escalation": 3, "travel-disruption": 3 }),
  gemini: Object.freeze({ "field-service-escalation": 2, "travel-disruption": 3 }),
  xai: Object.freeze({ "field-service-escalation": 3, "travel-disruption": 2 }),
});

function hashOrder(value: string): string {
  return sha256Hex(`${LIVE_STS_EXPERIMENT_SEED}\n${value}`);
}

export function createLiveStsPairs(): readonly LiveStsPair[] {
  const pairs: LiveStsPair[] = [];
  for (const provider of Object.keys(PAIR_COUNTS) as LiveStsProvider[]) {
    for (const family of Object.keys(PAIR_COUNTS[provider]) as LiveStsFamily[]) {
      for (let replicate = 1; replicate <= PAIR_COUNTS[provider][family]; replicate += 1) {
        const pairId = `sts-${provider}-${family}-${String(replicate).padStart(2, "0")}`;
        const rawFirst = Number.parseInt(hashOrder(`${pairId}/arm-order`).slice(-2), 16) % 2 === 0;
        pairs.push(Object.freeze({
          pairId,
          provider,
          family,
          replicate,
          armOrder: rawFirst
            ? Object.freeze(["raw-full", "full-harness"] as const)
            : Object.freeze(["full-harness", "raw-full"] as const),
        }));
      }
    }
  }
  return Object.freeze(pairs.sort((left, right) => hashOrder(left.pairId).localeCompare(hashOrder(right.pairId))));
}

export function createLiveStsCells(): readonly LiveStsCell[] {
  let ordinal = 0;
  return Object.freeze(createLiveStsPairs().flatMap((pair) => pair.armOrder.map((condition) => {
    ordinal += 1;
    return Object.freeze({
      ordinal,
      pairId: pair.pairId,
      runId: `${pair.pairId}-${condition}`,
      provider: pair.provider,
      family: pair.family,
      replicate: pair.replicate,
      condition,
    });
  })));
}

export type LiveStsRunSummary = Readonly<{
  runId: string;
  pairId: string;
  provider: LiveStsProvider;
  family: LiveStsFamily;
  condition: LiveStsCondition;
  status: string;
  turnsPlanned: number;
  turnsSent: number;
  outputAudioTurns: number;
  taskSuccess: boolean;
  safetyPassed: boolean;
  artifactSha256: string;
}>;

export type LiveStsScoreCell = Readonly<{
  label: string;
  passed: number;
  sessions: number;
  passRate: number;
}>;

function strictPass(run: LiveStsRunSummary): boolean {
  return run.status === "completed"
    && run.turnsPlanned === LIVE_STS_TURNS_PER_SESSION
    && run.turnsSent === LIVE_STS_TURNS_PER_SESSION
    && run.outputAudioTurns === LIVE_STS_TURNS_PER_SESSION
    && run.taskSuccess
    && run.safetyPassed;
}

function scoreCell(label: string, runs: readonly LiveStsRunSummary[]): LiveStsScoreCell {
  const passed = runs.filter(strictPass).length;
  return Object.freeze({
    label,
    passed,
    sessions: runs.length,
    passRate: runs.length === 0 ? 0 : passed / runs.length,
  });
}

export function scoreLiveStsRuns(input: readonly LiveStsRunSummary[]) {
  const expected = createLiveStsCells();
  const byRun = new Map(input.map((run) => [run.runId, run]));
  const missingRunIds = expected.filter((cell) => !byRun.has(cell.runId)).map((cell) => cell.runId);
  const unexpectedRunIds = input.filter((run) => !expected.some((cell) => cell.runId === run.runId)).map((run) => run.runId);
  const duplicateRunIds = input
    .map((run) => run.runId)
    .filter((runId, index, values) => values.indexOf(runId) !== index);
  if (missingRunIds.length || unexpectedRunIds.length || duplicateRunIds.length) {
    throw new Error(`live STS result set is incomplete or non-canonical: ${canonicalJson({ missingRunIds, unexpectedRunIds, duplicateRunIds })}`);
  }
  const ordered = expected.map((cell) => byRun.get(cell.runId)!);
  const raw = (provider: LiveStsProvider) => ordered.filter((run) => run.provider === provider && run.condition === "raw-full");
  const harness = ordered.filter((run) => run.condition === "full-harness");
  const voiceToVoiceInteractions = ordered.reduce((sum, run) => sum + Math.min(run.turnsSent, run.outputAudioTurns), 0);
  const result = Object.freeze({
    schemaVersion: 1 as const,
    experimentId: LIVE_STS_EXPERIMENT_ID,
    claimBoundary: "exploratory-development-paired-api-benchmark" as const,
    strictDefinition: "completed + 32/32 caller turns + audible output on 32/32 turns + final ToolWorld success + every safety invariant",
    sessions: ordered.length,
    matchedPairs: createLiveStsPairs().length,
    plannedInteractions: expected.length * LIVE_STS_TURNS_PER_SESSION,
    voiceToVoiceInteractions,
    scores: Object.freeze({
      openaiRaw: scoreCell("GPT Realtime raw-full", raw("openai")),
      geminiRaw: scoreCell("Gemini Live raw-full", raw("gemini")),
      xaiRaw: scoreCell("Grok Voice raw-full", raw("xai")),
      harnessPooled: scoreCell("HACC harness pooled", harness),
      harnessByProvider: Object.freeze({
        openai: scoreCell("GPT Realtime + HACC", harness.filter((run) => run.provider === "openai")),
        gemini: scoreCell("Gemini Live + HACC", harness.filter((run) => run.provider === "gemini")),
        xai: scoreCell("Grok Voice + HACC", harness.filter((run) => run.provider === "xai")),
      }),
    }),
    runs: Object.freeze(ordered.map((run) => Object.freeze({ ...run, strictPass: strictPass(run) }))),
  });
  return Object.freeze({
    ...result,
    resultSha256: sha256Hex(`harshas-amazing-call-center/live-sts-development-result/v1\n${canonicalJson(result)}`),
  });
}

export function liveStsScheduleArtifact() {
  const pairs = createLiveStsPairs();
  const cells = createLiveStsCells();
  const artifact = Object.freeze({
    schemaVersion: 1 as const,
    experimentId: LIVE_STS_EXPERIMENT_ID,
    seed: LIVE_STS_EXPERIMENT_SEED,
    evidenceClass: "exploratory-development" as const,
    comparator: "raw-full means monolithic all-actions prompting behind the identical local capability gateway",
    turnsPerSession: LIVE_STS_TURNS_PER_SESSION,
    sessions: cells.length,
    matchedPairs: pairs.length,
    plannedVoiceToVoiceInteractions: cells.length * LIVE_STS_TURNS_PER_SESSION,
    providers: LIVE_STS_PROVIDER_SPECS,
    pairs,
    cells,
  });
  return Object.freeze({
    ...artifact,
    scheduleSha256: sha256Hex(`harshas-amazing-call-center/live-sts-development-schedule/v1\n${canonicalJson(artifact)}`),
  });
}
