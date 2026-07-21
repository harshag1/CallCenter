#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { canonicalJson, sha256Hex } from "../lib/benchmark/artifacts";
import {
  createBudgetLedger,
  settleBudgetReservation,
  type BudgetLedger,
} from "../lib/benchmark/budget";
import { freezeCallerAudioIndex } from "../lib/benchmark/caller-world-scheduler";
import { compileConditionSuite, type BenchmarkConditionId } from "../lib/benchmark/condition-compiler";
import { InMemoryBenchmarkGatewayKernel } from "../lib/benchmark/gateway-kernel";
import {
  createBenchmarkKernelAttestationSigner,
  type BenchmarkKernelEvidenceBinding,
} from "../lib/benchmark/kernel-attestation";
import {
  LONG_CALL_MAXIMUM_AGGREGATE_USD,
  LONG_CALL_MAXIMUM_USD_PER_EPISODE,
  LONG_CALL_PROTOCOL_ID,
  LONG_CALL_TTS_VOICES,
  assertLongCallBudgetLedgerMatchesSchedule,
  classifyLongCallFailure,
  createLongCallBudgetLedger,
  createLongCallPairs,
  isStrictLongCallPass,
  longCallScheduleArtifact,
  longUsefulnessTask,
  scoreLongCallExperiment,
  type LongCallCell,
  type LongCallSummary,
  type LongCallTtsVoice,
} from "../lib/benchmark/long-call-live-experiment";
import {
  createPairedAudioManifest,
  runBenchmarkTrial,
  type CallerAudioTurn,
} from "../lib/benchmark/orchestrator";
import {
  createProductionRealtimeClient,
  loadProductionRealtimeCredentials,
} from "../lib/benchmark/production-realtime-provider";
import { evaluateScenarioWorld } from "../lib/benchmark/tool-world";
import { createUsefulnessCallerSchedulePlan } from "../lib/benchmark/usefulness-task-suite";
import { AgentFlowSchema } from "../lib/flow";

const execFile = promisify(execFileCallback);
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_ROOT = resolve(REPOSITORY_ROOT, "benchmarks/voice-long-horizon/.local/hacc-lc3-v1");
const DEFAULT_PROVIDER_ENV = "/Users/harsha/Desktop/gpu-hub-harness/.secrets/staging-runtime-provider.env";
const PLAN_FILE = "experiment-plan.json";
const LEDGER_FILE = "budget-ledger.json";
const PRIVATE_KEY_FILE = "operator-ed25519.private.pem";
const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

type FixtureEntry = Readonly<{
  taskSha256: string;
  family: LongCallCell["family"];
  ttsVoice: LongCallTtsVoice;
  turnId: string;
  sourceTextSha256: string;
  sampleRateHz: 16_000 | 24_000;
  path: string;
  sha256: string;
  byteLength: number;
}>;

type ExperimentPlan = Readonly<{
  schemaVersion: 1;
  protocolId: typeof LONG_CALL_PROTOCOL_ID;
  experimentId: string;
  createdAt: string;
  sourceCommit: string;
  sourceTree: string;
  schedule: ReturnType<typeof longCallScheduleArtifact>;
  fixtures: readonly FixtureEntry[];
  fixtureManifestSha256: string;
  fixtureToolchain: Readonly<{ macos: string; ffmpeg: string }>;
  signer: Readonly<{ keyId: string; publicKeyPem: string; publicKeySha256: string }>;
  planSha256: string;
}>;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
  return value;
}

function rootDirectory(): string {
  return resolve(option("root") ?? DEFAULT_ROOT);
}

async function git(...args: string[]): Promise<string> {
  const result = await execFile("git", args, { cwd: REPOSITORY_ROOT, maxBuffer: 16 * 1024 * 1024 });
  return result.stdout.trim();
}

async function sourceState(): Promise<{ commit: string; tree: string }> {
  const [status, commit, tree] = await Promise.all([
    git("status", "--porcelain"),
    git("rev-parse", "HEAD"),
    git("rev-parse", "HEAD^{tree}"),
  ]);
  if (status) throw new Error("HACC-LC3 requires a clean checkout before prepare and every paid run");
  return { commit, tree };
}

async function commandFirstLine(command: string, args: readonly string[]): Promise<string> {
  const result = await execFile(command, [...args], { maxBuffer: 4 * 1024 * 1024 });
  return `${result.stdout}\n${result.stderr}`.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "unknown";
}

async function generateFixtures(root: string): Promise<readonly FixtureEntry[]> {
  const entries: FixtureEntry[] = [];
  const temporaryRoot = resolve(root, "fixture-work");
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  let ordinal = 0;
  try {
    for (const family of ["museum", "campus", "water"] as const) {
      const task = longUsefulnessTask(family);
      for (const ttsVoice of LONG_CALL_TTS_VOICES) {
        for (const turn of task.scenario.caller.turns) {
          ordinal += 1;
          const aiff = resolve(temporaryRoot, `${String(ordinal).padStart(3, "0")}.aiff`);
          await execFile("say", ["-v", ttsVoice, "-r", "180", "-o", aiff, turn.utterance]);
          for (const sampleRateHz of [16_000, 24_000] as const) {
            const relative = `fixtures/${family}/${ttsVoice.toLowerCase()}/${sampleRateHz}/${turn.id}.pcm`;
            const destination = resolve(root, relative);
            await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
            await execFile("ffmpeg", [
              "-nostdin", "-loglevel", "error", "-y", "-i", aiff,
              "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", String(sampleRateHz), destination,
            ]);
            const bytes = new Uint8Array(await readFile(destination));
            if (bytes.byteLength === 0) throw new Error(`empty fixture ${relative}`);
            entries.push(Object.freeze({
              taskSha256: task.suite_sha256,
              family,
              ttsVoice,
              turnId: turn.id,
              sourceTextSha256: sha256Hex(turn.utterance),
              sampleRateHz,
              path: relative,
              sha256: sha256Hex(bytes),
              byteLength: bytes.byteLength,
            }));
          }
          await rm(aiff, { force: true });
        }
      }
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  return Object.freeze(entries);
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${canonicalJson(value)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

async function prepare(root: string): Promise<void> {
  const source = await sourceState();
  const experimentId = root.split(sep).at(-1);
  if (!experimentId || !/^hacc-lc3-v[1-9][0-9]*$/.test(experimentId)) {
    throw new Error("experiment root basename must be hacc-lc3-vN");
  }
  try {
    await stat(root);
    throw new Error(`experiment root already exists: ${root}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(root, { recursive: false, mode: 0o700 });
  const fixtures = await generateFixtures(root);
  const keys = generateKeyPairSync("ed25519");
  const privateKeyPem = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicKeyPem = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
  const signer = createBenchmarkKernelAttestationSigner({
    keyId: `${experimentId}-operator`,
    privateKeyPem,
    publicKeyPem,
  });
  const body = Object.freeze({
    schemaVersion: 1 as const,
    protocolId: LONG_CALL_PROTOCOL_ID,
    experimentId,
    createdAt: new Date().toISOString(),
    sourceCommit: source.commit,
    sourceTree: source.tree,
    schedule: longCallScheduleArtifact(),
    fixtures,
    fixtureManifestSha256: sha256Hex(canonicalJson(fixtures)),
    fixtureToolchain: Object.freeze({
      macos: await commandFirstLine("sw_vers", ["-productVersion"]),
      ffmpeg: await commandFirstLine("ffmpeg", ["-version"]),
    }),
    signer: Object.freeze({ keyId: signer.keyId, publicKeyPem, publicKeySha256: signer.publicKeySha256 }),
  });
  const plan: ExperimentPlan = Object.freeze({
    ...body,
    planSha256: sha256Hex(`harshas-amazing-call-center/long-call-plan/v1\n${canonicalJson(body)}`),
  });
  const ledger = createLongCallBudgetLedger(plan.createdAt);
  await writeFile(resolve(root, PRIVATE_KEY_FILE), privateKeyPem, { flag: "wx", mode: 0o600 });
  await writeFile(resolve(root, PLAN_FILE), `${canonicalJson(plan)}\n`, { flag: "wx", mode: 0o600 });
  await writeFile(resolve(root, LEDGER_FILE), `${canonicalJson(ledger)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(root, 0o700);
  process.stdout.write(`${canonicalJson({
    action: "prepared",
    protocolId: LONG_CALL_PROTOCOL_ID,
    root,
    planSha256: plan.planSha256,
    fixtureManifestSha256: plan.fixtureManifestSha256,
    pairs: plan.schedule.scheduledPairs,
    episodes: plan.schedule.scheduledEpisodes,
    callerTurns: plan.schedule.scheduledCallerTurns,
    maximumAggregateUsd: LONG_CALL_MAXIMUM_AGGREGATE_USD,
  })}\n`);
}

async function loadPlan(root: string): Promise<ExperimentPlan> {
  const plan = JSON.parse(await readFile(resolve(root, PLAN_FILE), "utf8")) as ExperimentPlan;
  if (plan.protocolId !== LONG_CALL_PROTOCOL_ID) throw new Error("unexpected protocol ID");
  if (root.split(sep).at(-1) !== plan.experimentId) throw new Error("experiment root differs from frozen experimentId");
  const { planSha256, ...body } = plan;
  const computed = sha256Hex(`harshas-amazing-call-center/long-call-plan/v1\n${canonicalJson(body)}`);
  if (computed !== planSha256) throw new Error("experiment plan hash mismatch");
  if (canonicalJson(plan.schedule) !== canonicalJson(longCallScheduleArtifact())) throw new Error("canonical schedule changed after prepare");
  const source = await sourceState();
  if (source.commit !== plan.sourceCommit || source.tree !== plan.sourceTree) throw new Error("source changed after prepare");
  return plan;
}

async function verifyFixtures(root: string, plan: ExperimentPlan): Promise<void> {
  if (sha256Hex(canonicalJson(plan.fixtures)) !== plan.fixtureManifestSha256) throw new Error("fixture manifest hash mismatch");
  for (const entry of plan.fixtures) {
    if (!SAFE_PATH.test(entry.path) || entry.path.split("/").some((part) => part === "." || part === "..")) {
      throw new Error(`unsafe fixture path ${entry.path}`);
    }
    const path = resolve(root, entry.path);
    if (!path.startsWith(`${root}${sep}`)) throw new Error(`fixture escapes experiment root: ${entry.path}`);
    const bytes = new Uint8Array(await readFile(path));
    if (bytes.byteLength !== entry.byteLength || sha256Hex(bytes) !== entry.sha256) {
      throw new Error(`fixture mismatch: ${entry.path}`);
    }
  }
}

function audioReference(entry: FixtureEntry) {
  return {
    turn_id: entry.turnId,
    fixture_set_id: `lc3_${entry.taskSha256.slice(0, 24)}_${entry.ttsVoice.toLowerCase()}`,
    fixture_manifest_sha256: "0".repeat(64),
    source_text_sha256: entry.sourceTextSha256,
    rendition: entry.sampleRateHz === 16_000 ? "pcm16le_mono_16000" as const : "pcm16le_mono_24000" as const,
    pcm_sha256: entry.sha256,
    byte_length: entry.byteLength,
    sample_rate_hz: entry.sampleRateHz,
    channels: 1 as const,
    encoding: "pcm16" as const,
  };
}

async function callerAudio(root: string, plan: ExperimentPlan, cell: LongCallCell) {
  const task = longUsefulnessTask(cell.family);
  const selected = plan.fixtures.filter((entry) =>
    entry.taskSha256 === task.suite_sha256
    && entry.ttsVoice === cell.ttsVoice
    && entry.sampleRateHz === cell.sampleRateHz
  );
  const entries = new Map(selected.map((entry) => [entry.turnId, entry]));
  const callerTurns: CallerAudioTurn[] = [];
  const references: Record<string, ReturnType<typeof audioReference>> = {};
  for (const turn of task.scenario.caller.turns) {
    const entry = entries.get(turn.id);
    if (!entry) throw new Error(`missing fixture ${cell.pairId}/${turn.id}`);
    const bytes = new Uint8Array(await readFile(resolve(root, entry.path)));
    callerTurns.push(Object.freeze({
      turnId: turn.id,
      audio: Object.freeze({ encoding: "pcm16" as const, sampleRateHz: cell.sampleRateHz, channels: 1 as const, data: bytes }),
    }));
    references[turn.id] = audioReference(entry);
  }
  const manifestHash = sha256Hex(canonicalJson(selected));
  const audioIndex = freezeCallerAudioIndex({
    schema_version: 1,
    scenario_id: task.scenario.id,
    scenario_version: task.scenario.version,
    fixture_set_id: `lc3_${task.suite_sha256.slice(0, 24)}_${cell.ttsVoice.toLowerCase()}`,
    fixture_manifest_sha256: manifestHash,
    rendition: cell.sampleRateHz === 16_000 ? "pcm16le_mono_16000" : "pcm16le_mono_24000",
    turns: Object.fromEntries(Object.entries(references).map(([turnId, reference]) => [turnId, {
      ...reference,
      fixture_manifest_sha256: manifestHash,
    }])),
  });
  return { task, callerTurns: Object.freeze(callerTurns), audioIndex };
}

function estimatedCost(provider: LongCallCell["provider"], metrics: Readonly<{
  inputAudioMs: number;
  outputAudioMs: number;
  usage: readonly Readonly<{
    inputTextTokens?: number;
    inputAudioTokens?: number;
    outputTextTokens?: number;
    outputAudioTokens?: number;
  }>[];
}>): number {
  if (provider === "xai") return (metrics.inputAudioMs + metrics.outputAudioMs) / 60_000 * 0.05;
  if (provider === "gemini") return metrics.inputAudioMs / 60_000 * 0.005 + metrics.outputAudioMs / 60_000 * 0.018;
  return metrics.usage.reduce((total, item) => total
    + (item.inputTextTokens ?? 0) * 4 / 1_000_000
    + (item.inputAudioTokens ?? 0) * 32 / 1_000_000
    + (item.outputTextTokens ?? 0) * 24 / 1_000_000
    + (item.outputAudioTokens ?? 0) * 64 / 1_000_000, 0);
}

async function persistArtifacts(root: string, result: Awaited<ReturnType<typeof runBenchmarkTrial>>): Promise<void> {
  for (const file of result.artifacts.files) {
    if (!SAFE_PATH.test(file.path) || file.path.split("/").some((part) => part === "." || part === "..")) {
      throw new Error(`unsafe result artifact path ${file.path}`);
    }
    const destination = resolve(root, "artifacts", file.path);
    if (!destination.startsWith(`${resolve(root, "artifacts")}${sep}`)) throw new Error("artifact path escapes run root");
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, file.content, { flag: "wx", mode: 0o600 });
  }
  await writeFile(resolve(root, "artifacts/runner-manifest.json"), result.artifacts.manifestJson, { flag: "wx", mode: 0o600 });
}

let ledgerMutation: Promise<void> = Promise.resolve();

async function settleAggregateLedger(root: string, cell: LongCallCell, estimatedUsd: number | null): Promise<void> {
  const mutation = ledgerMutation.then(async () => {
    const path = resolve(root, LEDGER_FILE);
    const ledger = JSON.parse(await readFile(path, "utf8")) as BudgetLedger;
    const next = settleBudgetReservation(ledger, `${cell.runId}-aggregate-reservation`, {
      estimated_usd: (estimatedUsd ?? Number(LONG_CALL_MAXIMUM_USD_PER_EPISODE)).toFixed(6),
    });
    await atomicJson(path, next);
  });
  ledgerMutation = mutation.catch(() => undefined);
  return mutation;
}

async function runCell(root: string, plan: ExperimentPlan, cell: LongCallCell, apiKey: string): Promise<void> {
  const runsRoot = resolve(root, "runs");
  const partial = resolve(runsRoot, `${cell.runId}.partial`);
  const complete = resolve(runsRoot, `${cell.runId}.complete`);
  try {
    await stat(complete);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await stat(partial);
    throw new Error(`partial run exists; no-retry policy blocks ${cell.runId}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const aggregateLedger = JSON.parse(await readFile(resolve(root, LEDGER_FILE), "utf8")) as BudgetLedger;
  const aggregateReservation = aggregateLedger.reservations.find((reservation) =>
    reservation.reservation_id === `${cell.runId}-aggregate-reservation`
  );
  if (aggregateReservation?.status !== "active") {
    throw new Error(`aggregate reservation is not active; no-retry policy blocks ${cell.runId}`);
  }
  await mkdir(partial, { recursive: false, mode: 0o700 });
  await writeFile(resolve(partial, "scheduled.json"), `${canonicalJson({
    schemaVersion: 1,
    protocolId: LONG_CALL_PROTOCOL_ID,
    planSha256: plan.planSha256,
    cell,
    scheduledBeforeSocket: true,
  })}\n`, { flag: "wx", mode: 0o600 });
  const loaded = await callerAudio(root, plan, cell);
  const suite = compileConditionSuite(loaded.task.compiler_input);
  const condition = suite.conditions[cell.condition as BenchmarkConditionId];
  const pairedAudio = createPairedAudioManifest({ pairId: cell.pairId, scenario: loaded.task.scenario, callerTurns: loaded.callerTurns });
  const pairInvariantsHash = sha256Hex(`hacc-lc3/pair/v1\n${canonicalJson({
    planSha256: plan.planSha256,
    pairId: cell.pairId,
    provider: cell.provider,
    model: cell.model,
    family: cell.family,
    ttsVoice: cell.ttsVoice,
    taskSha256: loaded.task.suite_sha256,
    pairedAudio,
  })}`);
  const cellPlanSha256 = sha256Hex(`hacc-lc3/cell/v1\n${canonicalJson({
    planSha256: plan.planSha256,
    cell,
    conditionHash: condition.conditionHash,
    pairInvariantsHash,
  })}`);
  const signer = createBenchmarkKernelAttestationSigner({
    keyId: plan.signer.keyId,
    privateKeyPem: await readFile(resolve(root, PRIVATE_KEY_FILE), "utf8"),
    publicKeyPem: plan.signer.publicKeyPem,
  });
  const evidenceBinding: BenchmarkKernelEvidenceBinding = Object.freeze({
    pairId: cell.pairId,
    leaseSubjectId: cell.pairId,
    provider: cell.provider,
    model: cell.model,
    planSha256: cellPlanSha256,
    freezeLockSha256: plan.planSha256,
    kernelBuildSha256: sha256Hex(`git-tree\n${plan.sourceTree}`),
  });
  const gatewayKernel = new InMemoryBenchmarkGatewayKernel({
    flow: AgentFlowSchema.parse(loaded.task.compiler_input.flow),
    expectedFlowHash: suite.flowHash,
    expectedScenarioHash: suite.scenarioHash,
    expectedConditionHash: condition.conditionHash,
    grantBindingHash: suite.sourceHash,
    leaseSubjectId: cell.pairId,
    evidenceBinding,
    signer,
    capabilitySecret: sha256Hex(`hacc-lc3-capability\n${plan.planSha256}\n${cell.runId}`),
    leaseTtlSeconds: 10 * 60,
    autoAdvanceLinearFlow: true,
  });

  let summary: LongCallSummary;
  try {
    const inputBytes = loaded.callerTurns.reduce((total, turn) => total + (
      Array.isArray(turn.audio)
        ? turn.audio.reduce((turnTotal, segment) => turnTotal + segment.data.byteLength, 0)
        : (turn.audio as { data: Uint8Array }).data.byteLength
    ), 0);
    const result = await runBenchmarkTrial({
      runId: cell.runId,
      provider: cell.provider,
      model: cell.model,
      scenario: loaded.task.scenario,
      createClient: (configuration) => createProductionRealtimeClient(cell.provider, configuration, apiKey),
      condition,
      gatewayKernel,
      kernelAttestationExpectation: {
        evidenceBinding,
        trust: { keyId: signer.keyId, publicKeySha256: signer.publicKeySha256, publicKeyPem: plan.signer.publicKeyPem },
      },
      journalSecretValues: [apiKey],
      callerTurns: loaded.callerTurns,
      pairedAudio,
      callerSchedulePlan: createUsefulnessCallerSchedulePlan({
        task: loaded.task,
        run_id: cell.runId,
        created_at: plan.createdAt,
        audio: loaded.audioIndex,
      }),
      pairInvariantsHash,
      studyPlanHash: plan.planSha256,
      limits: {
        maxTurns: 20,
        maxSessionMs: 10 * 60_000,
        maxInputAudioBytes: inputBytes,
        maxOutputAudioBytes: 64 * 1024 * 1024,
        maxToolCalls: 128,
        sessionReadyTimeoutMs: 15_000,
        responseTimeoutMs: 45_000,
      },
      budget: {
        ledger: createBudgetLedger({ authorization_ceiling_usd: "5", scheduling_stop_usd: "5" }),
        reservationId: `${cell.runId}-cell-reservation`,
        maximumUsd: LONG_CALL_MAXIMUM_USD_PER_EPISODE,
        persistLedger: async () => undefined,
        estimateCost: (metrics) => ({ estimatedUsd: estimatedCost(cell.provider, metrics).toFixed(6) }),
      },
    });
    await persistArtifacts(partial, result);
    const evaluation = evaluateScenarioWorld(loaded.task.scenario, result.world);
    const transportTerminal = result.status === "completed" && result.callerSchedule?.status === "complete";
    const worldOutcomePass = evaluation.success.every((assertion) => assertion.passed);
    const systemIntegrityPass = evaluation.safety.every((assertion) => assertion.passed);
    const core = {
      turnsPlanned: result.counters.turnsPlanned,
      turnsSent: result.counters.turnsSent,
      outputAudioTurns: result.providerEvidence.audio.output.length,
      transportTerminal,
      worldOutcomePass,
      systemIntegrityPass,
    };
    const reservation = result.budgetLedger.reservations.find((candidate) => candidate.reservation_id === `${cell.runId}-cell-reservation`);
    summary = Object.freeze({
      schemaVersion: 1,
      protocolId: LONG_CALL_PROTOCOL_ID,
      runId: cell.runId,
      pairId: cell.pairId,
      provider: cell.provider,
      model: cell.model,
      family: cell.family,
      ttsVoice: cell.ttsVoice,
      condition: cell.condition,
      status: result.status,
      callerScheduleStatus: result.callerSchedule?.status ?? null,
      ...core,
      strictPass: isStrictLongCallPass(core),
      estimatedCostUsd: reservation?.costs.estimated_micro_usd == null ? null : reservation.costs.estimated_micro_usd / 1_000_000,
      artifactManifestSha256: sha256Hex(result.artifacts.manifestJson),
      failureClass: classifyLongCallFailure(core),
    });
  } catch (error) {
    const core = {
      turnsPlanned: 20,
      turnsSent: 0,
      outputAudioTurns: 0,
      transportTerminal: false,
      worldOutcomePass: false,
      systemIntegrityPass: false,
    };
    summary = Object.freeze({
      schemaVersion: 1,
      protocolId: LONG_CALL_PROTOCOL_ID,
      runId: cell.runId,
      pairId: cell.pairId,
      provider: cell.provider,
      model: cell.model,
      family: cell.family,
      ttsVoice: cell.ttsVoice,
      condition: cell.condition,
      status: "runner_exception",
      callerScheduleStatus: null,
      ...core,
      strictPass: false,
      estimatedCostUsd: null,
      artifactManifestSha256: sha256Hex(`runner-exception\n${cell.runId}`),
      failureClass: "transport",
    });
    const rawMessage = error instanceof Error ? error.message : String(error);
    await writeFile(resolve(partial, "runner-error.json"), `${canonicalJson({
      errorClass: error instanceof Error ? error.name : "NonErrorThrow",
      message: rawMessage.replaceAll(apiKey, "[REDACTED]").slice(0, 2_000),
      messageSha256: sha256Hex(rawMessage),
    })}\n`, { flag: "wx", mode: 0o600 });
    try {
      await writeFile(resolve(partial, "kernel-transcript-on-error.jsonl"), gatewayKernel.encodedTranscript(), { flag: "wx", mode: 0o600 });
    } catch {
      // Initialization may fail before a public kernel transcript exists.
    }
  }
  await writeFile(resolve(partial, "summary.json"), `${canonicalJson(summary)}\n`, { flag: "wx", mode: 0o600 });
  await settleAggregateLedger(root, cell, summary.estimatedCostUsd);
  await rename(partial, complete);
  process.stdout.write(`${canonicalJson({ action: "episode-retained", pairOrdinal: cell.pairOrdinal, runId: cell.runId, status: summary.status })}\n`);
}

async function credentials() {
  if (!process.env.BENCHMARK_PROVIDER_ENV_FILE) process.env.BENCHMARK_PROVIDER_ENV_FILE = DEFAULT_PROVIDER_ENV;
  return loadProductionRealtimeCredentials(REPOSITORY_ROOT);
}

async function run(root: string, concurrency: number): Promise<void> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 9) throw new Error("concurrency must be 1..9 pairs");
  const plan = await loadPlan(root);
  await verifyFixtures(root, plan);
  assertLongCallBudgetLedgerMatchesSchedule(JSON.parse(await readFile(resolve(root, LEDGER_FILE), "utf8")) as BudgetLedger);
  const providerCredentials = await credentials();
  await mkdir(resolve(root, "runs"), { recursive: true, mode: 0o700 });
  const selectedPairId = option("pair-id");
  const selectedPairs = selectedPairId
    ? createLongCallPairs().filter((pair) => pair.pairId === selectedPairId)
    : createLongCallPairs();
  if (selectedPairs.length === 0) throw new Error(`pair-id is not present in the frozen plan: ${selectedPairId}`);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, selectedPairs.length) }, async () => {
    while (true) {
      const pair = selectedPairs[cursor++];
      if (!pair) return;
      const adjacentCells = plan.schedule.cells.filter((cell) => cell.pairId === pair.pairId);
      for (const cell of adjacentCells) await runCell(root, plan, cell, providerCredentials[cell.provider]);
    }
  }));
}

async function report(root: string): Promise<void> {
  const plan = await loadPlan(root);
  const summaries = await Promise.all(plan.schedule.cells.map(async (cell) => JSON.parse(await readFile(
    resolve(root, "runs", `${cell.runId}.complete`, "summary.json"),
    "utf8",
  )) as LongCallSummary));
  const result = scoreLongCallExperiment(summaries);
  const withPlan = Object.freeze({ ...result, experimentId: plan.experimentId, planSha256: plan.planSha256, sourceCommit: plan.sourceCommit });
  await atomicJson(resolve(root, "result.json"), withPlan);
  const markdown = [
    "# HACC-LC3-v1 long-call benchmark",
    "",
    `- Result SHA-256: \`${result.resultSha256}\``,
    `- Scheduled episodes: **${result.scheduledEpisodes}** (${result.scheduledPairs} matched pairs)`,
    `- Scheduled caller turns: **${result.scheduledCallerTurns}**`,
    `- Completed voice-to-voice interactions: **${result.completedVoiceToVoiceInteractions}**`,
    `- Estimated API cost: **$${result.estimatedCostUsd.toFixed(4)}**`,
    "- Primary endpoint: terminal transport + 20/20 caller turns + 20/20 audible outputs + final ToolWorld success + every safety invariant.",
    "- Arms: provider-native raw-memory vs identical realtime model behind HACC full-harness, paired on task and frozen caller PCM.",
    "",
    "| Provider / pinned model | Native | + HACC | Difference | HACC-only | Native-only | Exact McNemar p |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...result.providerEffects.map((effect) => `| ${effect.provider} / ${effect.model} | ${effect.rawPasses}/${effect.scheduledPairs} | ${effect.harnessPasses}/${effect.scheduledPairs} | ${(effect.pairedRiskDifference * 100).toFixed(1)} pp | ${effect.harnessOnly} | ${effect.rawOnly} | ${effect.exactMcNemarTwoSidedP.toFixed(6)} |`),
    "",
    "## Outcome decomposition",
    "",
    "| Provider | Native transport | HACC transport | Native world | HACC world | Native safety | HACC safety |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...result.providerEffects.map((effect) => `| ${effect.provider} | ${effect.transport.raw}/9 | ${effect.transport.harness}/9 | ${effect.world.raw}/9 | ${effect.world.harness}/9 | ${effect.system.raw}/9 | ${effect.system.harness}/9 |`),
    "",
    "Transport failures are reported separately from semantic world failures and system/guardrail failures. Failed or missing episodes are never removed, and paid episodes are never retried.",
    "",
  ].join("\n");
  await writeFile(resolve(root, "result.md"), markdown, { mode: 0o600 });
  process.stdout.write(`${canonicalJson({ action: "reported", resultSha256: result.resultSha256, providerEffects: result.providerEffects })}\n`);
}

async function inspect(root: string): Promise<void> {
  const plan = await loadPlan(root);
  await verifyFixtures(root, plan);
  const ledger = JSON.parse(await readFile(resolve(root, LEDGER_FILE), "utf8")) as BudgetLedger;
  assertLongCallBudgetLedgerMatchesSchedule(ledger);
  const runEntries = await readdir(resolve(root, "runs")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  process.stdout.write(`${canonicalJson({
    action: "inspected",
    planSha256: plan.planSha256,
    fixtureManifestSha256: plan.fixtureManifestSha256,
    completeEpisodes: runEntries.filter((entry) => entry.endsWith(".complete")).length,
    partialEpisodes: runEntries.filter((entry) => entry.endsWith(".partial")).length,
    reservations: ledger.reservations.length,
    settledReservations: ledger.reservations.filter((reservation) => reservation.status === "settled").length,
  })}\n`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const root = rootDirectory();
  if (command === "prepare") return prepare(root);
  if (command === "run") return run(root, Number(option("concurrency") ?? "3"));
  if (command === "report") return report(root);
  if (command === "inspect") return inspect(root);
  throw new Error("usage: long-call-live-benchmark <prepare|run|report|inspect> [--root DIR] [--concurrency 1..9] [--pair-id ID]");
}

main().catch((error) => {
  process.stderr.write(`${canonicalJson({
    errorClass: error instanceof Error ? error.name : "NonErrorThrow",
    message: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
});
