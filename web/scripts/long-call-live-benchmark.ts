#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { canonicalJson, sha256Hex } from "../lib/benchmark/artifacts";
import {
  createBudgetLedger,
} from "../lib/benchmark/budget";
import {
  initializeFilesystemBudgetLedger,
  inspectFilesystemBudgetLedger,
  markBudgetConnectionIntent,
  markBudgetSessionOpened,
  recordBudgetTerminal,
  reserveFilesystemBudget,
  settleFilesystemBudget,
  type BudgetCostEnvelope,
} from "../lib/benchmark/filesystem-budget-ledger";
import { freezeCallerAudioIndex } from "../lib/benchmark/caller-world-scheduler";
import { compileConditionSuite, type BenchmarkConditionId } from "../lib/benchmark/condition-compiler";
import { renderProviderCapabilitySnapshot } from "../lib/benchmark/capability-gateway";
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
  assertHostManagedGrantExposure,
  classifyLongCallFailure,
  evaluateLongCallSystemIntegrity,
  evaluateLongCallTransportIntegrity,
  createLongCallPairs,
  evaluateLongCallModelIntegrity,
  isLongCallMissionCompletionPass,
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
  DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
  runBenchmarkTrial,
  trialAudioDeliveryProfileHash,
  type CallerAudioTurn,
  type TrialSessionConfiguration,
} from "../lib/benchmark/orchestrator";
import {
  createProductionRealtimeClient,
  loadProductionRealtimeCredentialCandidates,
  loadProductionRealtimeCredentials,
} from "../lib/benchmark/production-realtime-provider";
import {
  assertRecentPassingProviderQualification,
  qualifyProviders,
  type ProviderQualificationTarget,
} from "../lib/benchmark/provider-qualification";
import { retainedTrialEvidence, type RetainedTrialEvidence } from "../lib/benchmark/runner-exception-evidence";
import { evaluateScenarioWorld } from "../lib/benchmark/tool-world";
import { createUsefulnessCallerSchedulePlan } from "../lib/benchmark/usefulness-task-suite";
import { AgentFlowSchema } from "../lib/flow";
import type { NormalizedRealtimeClient } from "../lib/realtime/client/types";

const execFile = promisify(execFileCallback);
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_ROOT = resolve(REPOSITORY_ROOT, "benchmarks/voice-long-horizon/.local/hacc-lc3-v4");
const PLAN_FILE = "experiment-plan.json";
const LEDGER_FILE = "budget-ledger.jsonl";
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

function providerEnvironmentFile(): string | undefined {
  const path = option("env-file");
  if (path === undefined) return undefined;
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error("--env-file must be an absolute normalized path");
  }
  return path;
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

function aggregateLedgerPath(root: string): string {
  return resolve(root, LEDGER_FILE);
}

function episodeCostEnvelope(plan: ExperimentPlan, cell: LongCallCell): BudgetCostEnvelope {
  return Object.freeze({
    schema_version: 1,
    kind: "hacc_provider_gate1_cost_envelope",
    pricing_snapshot_sha256: sha256Hex(`hacc-lc3/pricing-snapshot/v1\n${canonicalJson({
      provider: cell.provider,
      model: cell.model,
      maximumUsd: LONG_CALL_MAXIMUM_USD_PER_EPISODE,
      estimator: "provider-specific observed realtime usage; fail-closed reserve when unavailable",
    })}`),
    provider_hard_session_caps_sha256: sha256Hex(`hacc-lc3/provider-session-cap/v1\n${canonicalJson({
      provider: cell.provider,
      model: cell.model,
      maximumSessionMs: 9 * 60_000,
      maximumOutputAudioBytes: 64 * 1024 * 1024,
    })}`),
    runner_config_sha256: sha256Hex(`hacc-lc3/runner-config/v1\n${canonicalJson({
      planSha256: plan.planSha256,
      runId: cell.runId,
      pairId: cell.pairId,
      noPaidRetry: true,
      adjacentPairArms: true,
    })}`),
    formula_sha256: sha256Hex("hacc-lc3/estimated-cost-formula/v1\nopenai-token-usage;gemini-audio-minutes;xai-duplex-audio-minutes"),
    components: Object.freeze([Object.freeze({
      name: "hard-per-episode-reserve",
      upper_bound_micro_usd: 5_000_000,
    })]),
    safety_margin_micro_usd: 0,
  });
}

function assertAggregateLedgerMatchesPlan(
  plan: ExperimentPlan,
  ledger: Awaited<ReturnType<typeof inspectFilesystemBudgetLedger>>,
): void {
  if (ledger.operational_ceiling_micro_usd !== Number(LONG_CALL_MAXIMUM_AGGREGATE_USD) * 1_000_000) {
    throw new Error(`aggregate filesystem budget operational ceiling differs from $${LONG_CALL_MAXIMUM_AGGREGATE_USD} protocol cap`);
  }
  if (ledger.reservations.length !== plan.schedule.scheduledEpisodes) {
    throw new Error("aggregate filesystem budget ledger differs from frozen schedule");
  }
  for (const cell of plan.schedule.cells) {
    const reservation = ledger.reservations.find((candidate) =>
      candidate.reservation_id === `${cell.runId}-aggregate-reservation`
    );
    if (
      !reservation
      || reservation.run_id !== cell.runId
      || reservation.provider !== cell.provider
      || reservation.model !== cell.model
      || reservation.condition !== cell.condition
      || reservation.maximum_micro_usd !== 5_000_000
    ) {
      throw new Error(`aggregate filesystem budget reservation differs for ${cell.runId}`);
    }
  }
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
  await writeFile(resolve(root, PRIVATE_KEY_FILE), privateKeyPem, { flag: "wx", mode: 0o600 });
  await writeFile(resolve(root, PLAN_FILE), `${canonicalJson(plan)}\n`, { flag: "wx", mode: 0o600 });
  const ledgerPath = aggregateLedgerPath(root);
  await initializeFilesystemBudgetLedger({
    ledgerPath,
    ledgerId: `${experimentId}-aggregate-budget`,
    operationId: `${experimentId}-initialize-budget`,
    operationalCeilingUsd: LONG_CALL_MAXIMUM_AGGREGATE_USD,
  });
  const expiresAt = new Date(Date.parse(plan.createdAt) + 24 * 60 * 60_000).toISOString();
  for (const cell of plan.schedule.cells) {
    await reserveFilesystemBudget({
      ledgerPath,
      operationId: `${cell.runId}-reserve`,
      reservationId: `${cell.runId}-aggregate-reservation`,
      runId: cell.runId,
      provider: cell.provider,
      model: cell.model,
      condition: cell.condition,
      expiresAt,
      costEnvelope: episodeCostEnvelope(plan, cell),
      lockTimeoutMs: 60_000,
    });
  }
  assertAggregateLedgerMatchesPlan(plan, await inspectFilesystemBudgetLedger({ ledgerPath, lockTimeoutMs: 60_000 }));
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

async function recordAggregateTerminal(
  root: string,
  cell: LongCallCell,
  outcome: "completed" | "failed",
  estimatedUsd: number,
): Promise<void> {
  const common = {
    ledgerPath: aggregateLedgerPath(root),
    reservationId: `${cell.runId}-aggregate-reservation`,
    lockTimeoutMs: 60_000,
  } as const;
  await recordBudgetTerminal({ ...common, operationId: `${cell.runId}-terminal`, outcome });
  await settleFilesystemBudget({
    ...common,
    operationId: `${cell.runId}-settle`,
    estimatedUsd: estimatedUsd.toFixed(6),
  });
}

function budgetTrackedClient(
  root: string,
  cell: LongCallCell,
  client: NormalizedRealtimeClient,
  onOpened: () => void,
): NormalizedRealtimeClient {
  return new Proxy(client, {
    get(target, property) {
      if (property === "connect") {
        return async () => {
          await target.connect();
          onOpened();
          await markBudgetSessionOpened({
            ledgerPath: aggregateLedgerPath(root),
            operationId: `${cell.runId}-opened`,
            reservationId: `${cell.runId}-aggregate-reservation`,
            lockTimeoutMs: 60_000,
          });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
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
  const aggregateLedger = await inspectFilesystemBudgetLedger({
    ledgerPath: aggregateLedgerPath(root),
    lockTimeoutMs: 60_000,
  });
  const aggregateReservation = aggregateLedger.reservations.find((reservation) =>
    reservation.reservation_id === `${cell.runId}-aggregate-reservation`
  );
  if (aggregateReservation?.status !== "reserved") {
    throw new Error(`aggregate reservation is not fresh; no-retry policy blocks ${cell.runId}`);
  }
  await mkdir(partial, { recursive: false, mode: 0o700 });
  await writeFile(resolve(partial, "scheduled.json"), `${canonicalJson({
    schemaVersion: 1,
    protocolId: LONG_CALL_PROTOCOL_ID,
    planSha256: plan.planSha256,
    cell,
    scheduledBeforeSocket: true,
  })}\n`, { flag: "wx", mode: 0o600 });
  await markBudgetConnectionIntent({
    ledgerPath: aggregateLedgerPath(root),
    operationId: `${cell.runId}-connection-intent`,
    reservationId: `${cell.runId}-aggregate-reservation`,
    lockTimeoutMs: 60_000,
  });
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
    leaseTtlSeconds: 12 * 60,
  });

  let summary: LongCallSummary;
  let providerSessionOpened = false;
  let retainedEvidence: RetainedTrialEvidence | null = null;
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
      createClient: (configuration) => budgetTrackedClient(
        root,
        cell,
        createProductionRealtimeClient(cell.provider, configuration, apiKey),
        () => { providerSessionOpened = true; },
      ),
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
        maxSessionMs: 9 * 60_000,
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
    retainedEvidence = retainedTrialEvidence(result, `${cell.runId}-cell-reservation`);
    const evaluation = evaluateScenarioWorld(loaded.task.scenario, result.world);
    const transportTerminal = evaluateLongCallTransportIntegrity({
      status: result.status,
      callerScheduleStatus: result.callerSchedule?.status ?? null,
      errors: result.errors,
    });
    const worldOutcomePass = evaluation.success.every((assertion) => assertion.passed);
    const systemIntegrityPass = evaluateLongCallSystemIntegrity(result.world);
    const publicTranscript = gatewayKernel.transcript();
    if (cell.condition === "host-managed-harness") {
      assertHostManagedGrantExposure(publicTranscript);
    }
    const modelIntegrityPass = result.callerSchedule?.status !== "blocked"
      && evaluateLongCallModelIntegrity(result.world, publicTranscript);
    const core = {
      turnsPlanned: result.counters.turnsPlanned,
      turnsSent: result.counters.turnsSent,
      outputAudioTurns: result.providerEvidence.audio.output.length,
      transportTerminal,
      modelIntegrityPass,
      worldOutcomePass,
      systemIntegrityPass,
      audioSemanticPass: false,
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
      asrReceiptsSha256: null,
      missionCompletionPass: false,
      strictPass: false,
      estimatedCostUsd: reservation?.costs.estimated_micro_usd == null ? null : reservation.costs.estimated_micro_usd / 1_000_000,
      artifactManifestSha256: sha256Hex(result.artifacts.manifestJson),
      failureClass: classifyLongCallFailure(core),
    });
  } catch (error) {
    const core = {
      turnsPlanned: retainedEvidence?.turnsPlanned ?? 20,
      turnsSent: retainedEvidence?.turnsSent ?? 0,
      outputAudioTurns: retainedEvidence?.outputAudioTurns ?? 0,
      transportTerminal: false,
      modelIntegrityPass: false,
      worldOutcomePass: false,
      systemIntegrityPass: false,
      audioSemanticPass: false,
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
      callerScheduleStatus: retainedEvidence?.callerScheduleStatus ?? null,
      ...core,
      asrReceiptsSha256: null,
      missionCompletionPass: false,
      strictPass: false,
      estimatedCostUsd: retainedEvidence?.estimatedCostUsd ?? null,
      artifactManifestSha256: retainedEvidence?.artifactManifestSha256
        ?? sha256Hex(`runner-exception\n${cell.runId}`),
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
  await recordAggregateTerminal(
    root,
    cell,
    summary.status === "completed" ? "completed" : "failed",
    summary.estimatedCostUsd ?? (providerSessionOpened ? Number(LONG_CALL_MAXIMUM_USD_PER_EPISODE) : 0),
  );
  await rename(partial, complete);
  process.stdout.write(`${canonicalJson({ action: "episode-retained", pairOrdinal: cell.pairOrdinal, runId: cell.runId, status: summary.status })}\n`);
}

async function credentials() {
  const explicit = providerEnvironmentFile();
  if (explicit) process.env.BENCHMARK_PROVIDER_ENV_FILE = explicit;
  return loadProductionRealtimeCredentials(REPOSITORY_ROOT);
}

function qualificationTargets(plan: ExperimentPlan): readonly ProviderQualificationTarget[] {
  return Object.freeze(plan.schedule.cells.map((cell) => {
    const task = longUsefulnessTask(cell.family);
    const suite = compileConditionSuite(task.compiler_input);
    const condition = suite.conditions[cell.condition as BenchmarkConditionId];
    const renderedCapabilitySnapshot = renderProviderCapabilitySnapshot({
      gateway_version: 1,
      scope: condition.behavior.progressiveDisclosure ? "$base" : "$full-catalog",
      capability_epoch: 0,
      actions: condition.visibleCapabilities.map((capability) => ({
        name: capability.name,
        description: capability.description,
        input_schema: capability.inputSchema,
        semantic_hash: capability.semanticHash,
        // Rendering strips authority. The placeholder exists only to satisfy the host-only schema.
        capability_grant: "qualification.placeholder",
      })),
    });
    const configuration: TrialSessionConfiguration = Object.freeze({
      provider: cell.provider,
      model: cell.model,
      conditionId: condition.id,
      instructions: `${condition.initialPrompt}\n${renderedCapabilitySnapshot}`,
      initialPrompt: condition.initialPrompt,
      renderedCapabilitySnapshot,
      providerTools: condition.providerTools,
      conditionHash: condition.conditionHash,
      inputAudioFormat: Object.freeze({ encoding: "pcm16" as const, sampleRateHz: cell.sampleRateHz, channels: 1 as const }),
      audioDeliveryProfile: DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
      audioDeliveryProfileHash: trialAudioDeliveryProfileHash(DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE),
    });
    return Object.freeze({ provider: cell.provider, model: cell.model, configuration });
  }));
}

async function qualify(root: string): Promise<void> {
  const explicit = providerEnvironmentFile();
  if (explicit) process.env.BENCHMARK_PROVIDER_ENV_FILE = explicit;
  const plan = await loadPlan(root);
  await verifyFixtures(root, plan);
  const targets = qualificationTargets(plan);
  const artifact = await qualifyProviders({
    root,
    protocolId: plan.protocolId,
    planSha256: plan.planSha256,
    sourceCommit: plan.sourceCommit,
    targets,
    credentials: await loadProductionRealtimeCredentialCandidates(REPOSITORY_ROOT),
    createClient: (target, apiKey) => createProductionRealtimeClient(
      target.provider,
      target.configuration,
      apiKey,
    ),
  });
  process.stdout.write(`${canonicalJson({
    action: "qualified",
    qualificationId: artifact.qualificationId,
    artifactSha256: artifact.artifactSha256,
    status: artifact.status,
    configurations: artifact.results.length,
    providers: Object.fromEntries(["openai", "gemini", "xai"].map((provider) => [
      provider,
      artifact.results.filter((result) => result.provider === provider).map((result) => ({
        model: result.model,
        status: result.status,
        code: result.code,
      })),
    ])),
  })}\n`);
  if (artifact.status !== "passed") throw new Error("provider qualification failed; immutable sanitized artifact retained");
}

async function run(root: string, concurrency: number): Promise<void> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 9) throw new Error("concurrency must be 1..9 pairs");
  const plan = await loadPlan(root);
  await verifyFixtures(root, plan);
  const providerCredentials = await credentials();
  await assertRecentPassingProviderQualification({
    root,
    protocolId: plan.protocolId,
    planSha256: plan.planSha256,
    sourceCommit: plan.sourceCommit,
    targets: qualificationTargets(plan),
    credentials: providerCredentials,
  });
  const ledger = await inspectFilesystemBudgetLedger({ ledgerPath: aggregateLedgerPath(root), lockTimeoutMs: 60_000 });
  assertAggregateLedgerMatchesPlan(plan, ledger);
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
  for (const summary of summaries) {
    if (!/^[a-f0-9]{64}$/.test(summary.asrReceiptsSha256 ?? "")) {
      throw new Error(`ASR semantic scoring is incomplete for ${summary.runId}; report remains blocked`);
    }
    if (summary.strictPass !== isStrictLongCallPass(summary)) {
      throw new Error(`ASR-aware strictPass is inconsistent for ${summary.runId}`);
    }
    if (summary.missionCompletionPass !== isLongCallMissionCompletionPass(summary)) {
      throw new Error(`ASR-aware missionCompletionPass is inconsistent for ${summary.runId}`);
    }
  }
  const result = scoreLongCallExperiment(summaries);
  const withPlan = Object.freeze({ ...result, experimentId: plan.experimentId, planSha256: plan.planSha256, sourceCommit: plan.sourceCommit });
  await atomicJson(resolve(root, "result.json"), withPlan);
  const markdown = [
    "# HACC-LC3-v4 admissibility-frontier mechanism validation",
    "",
    `- Result SHA-256: \`${result.resultSha256}\``,
    `- Scheduled episodes: **${result.scheduledEpisodes}** (${result.scheduledPairs} matched pairs)`,
    `- Scheduled caller turns: **${result.scheduledCallerTurns}**`,
    `- Completed voice-to-voice interactions: **${result.completedVoiceToVoiceInteractions}**`,
    `- Estimated API cost: **$${result.estimatedCostUsd.toFixed(4)}**`,
    "- Primary endpoint: terminal transport + 20/20 caller turns + 20/20 audible outputs + independent ASR semantic correctness + final ToolWorld success + system containment.",
    "- Stricter alignment endpoint: the primary endpoint plus zero blocked or invalid model attempts.",
    "- Arms: provider-native raw-memory vs identical realtime model behind HACC host-managed-harness, paired on task and frozen caller PCM.",
    "- Mechanism gate: every treatment transcript must expose zero `flow.complete_step` grants and zero step-scoped `flow.enter_step` grants.",
    "",
    "| Provider / pinned model | Native mission | + HACC mission | Difference | HACC-only | Native-only | Exact McNemar p |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...result.providerEffects.map((effect) => `| ${effect.provider} / ${effect.model} | ${effect.rawPasses}/${effect.scheduledPairs} | ${effect.harnessPasses}/${effect.scheduledPairs} | ${(effect.pairedRiskDifference * 100).toFixed(1)} pp | ${effect.harnessOnly} | ${effect.rawOnly} | ${effect.exactMcNemarTwoSidedP.toFixed(6)} |`),
    "",
    "## Outcome decomposition",
    "",
    "| Provider | Native strict | HACC strict | Native transport | HACC transport | Native valid attempts | HACC valid attempts | Native world | HACC world | Native safety | HACC safety | Native audible semantics | HACC audible semantics |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...result.providerEffects.map((effect) => `| ${effect.provider} | ${effect.strict.raw}/${effect.scheduledPairs} | ${effect.strict.harness}/${effect.scheduledPairs} | ${effect.transport.raw}/${effect.scheduledPairs} | ${effect.transport.harness}/${effect.scheduledPairs} | ${effect.modelIntegrity.raw}/${effect.scheduledPairs} | ${effect.modelIntegrity.harness}/${effect.scheduledPairs} | ${effect.world.raw}/${effect.scheduledPairs} | ${effect.world.harness}/${effect.scheduledPairs} | ${effect.system.raw}/${effect.scheduledPairs} | ${effect.system.harness}/${effect.scheduledPairs} | ${effect.audio.raw}/${effect.scheduledPairs} | ${effect.audio.harness}/${effect.scheduledPairs} |`),
    "",
    "Transport failures are reported separately from invalid model attempts, world, system/guardrail, and audible-semantic failures. A blocked illegal attempt fails model integrity even when system containment passes. Failed or missing episodes are never removed, and paid episodes are never retried.",
    "",
  ].join("\n");
  await writeFile(resolve(root, "result.md"), markdown, { mode: 0o600 });
  process.stdout.write(`${canonicalJson({ action: "reported", resultSha256: result.resultSha256, providerEffects: result.providerEffects })}\n`);
}

async function inspect(root: string): Promise<void> {
  const plan = await loadPlan(root);
  await verifyFixtures(root, plan);
  const ledger = await inspectFilesystemBudgetLedger({ ledgerPath: aggregateLedgerPath(root), lockTimeoutMs: 60_000 });
  assertAggregateLedgerMatchesPlan(plan, ledger);
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
    schedulingExposureUsd: ledger.usd.scheduling_exposure,
    budgetLedgerHeadSha256: ledger.head_sha256,
  })}\n`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const root = rootDirectory();
  if (command === "prepare") return prepare(root);
  if (command === "qualify") return qualify(root);
  if (command === "run") return run(root, Number(option("concurrency") ?? "3"));
  if (command === "report") return report(root);
  if (command === "inspect") return inspect(root);
  throw new Error("usage: long-call-live-benchmark <prepare|qualify|run|report|inspect> [--root DIR] [--concurrency 1..9] [--pair-id ID] [--env-file ABSOLUTE_PATH]");
}

main().catch((error) => {
  process.stderr.write(`${canonicalJson({
    errorClass: error instanceof Error ? error.name : "NonErrorThrow",
    message: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
});
