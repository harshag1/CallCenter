#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { canonicalJson, sha256Hex } from "../lib/benchmark/artifacts";
import { createBudgetLedger } from "../lib/benchmark/budget";
import { freezeCallerAudioIndex } from "../lib/benchmark/caller-world-scheduler";
import { compileConditionSuite, type BenchmarkConditionId } from "../lib/benchmark/condition-compiler";
import { InMemoryBenchmarkGatewayKernel } from "../lib/benchmark/gateway-kernel";
import {
  createBenchmarkKernelAttestationSigner,
  type BenchmarkKernelEvidenceBinding,
} from "../lib/benchmark/kernel-attestation";
import { LIVE_STS_PROVIDER_SPECS, type LiveStsProvider } from "../lib/benchmark/live-sts-development-experiment";
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
import { AgentFlowSchema } from "../lib/flow";
import {
  USEFULNESS_DEVELOPMENT_SUITE_SHA256,
  USEFULNESS_DEVELOPMENT_TASKS,
  createUsefulnessCallerSchedulePlan,
  type UsefulnessDevelopmentTask,
} from "../lib/benchmark/usefulness-task-suite";

const execFile = promisify(execFileCallback);
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_ROOT = resolve(REPOSITORY_ROOT, "benchmarks/voice-long-horizon/.local/usefulness-live-canary-v7");
const PRIVATE_KEY_FILE = "operator-ed25519.private.pem";
const PLAN_FILE = "canary-plan.json";
const CONDITIONS = Object.freeze(["raw-memory", "full-harness"] as const);
const PROVIDERS = Object.freeze(["openai", "gemini", "xai"] as const);
const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

type CanaryCondition = typeof CONDITIONS[number];

type CanaryCell = Readonly<{
  ordinal: number;
  pairId: string;
  runId: string;
  provider: LiveStsProvider;
  family: UsefulnessDevelopmentTask["family"];
  condition: CanaryCondition;
}>;

type FixtureEntry = Readonly<{
  taskSha256: string;
  turnId: string;
  sourceTextSha256: string;
  sampleRateHz: 16_000 | 24_000;
  path: string;
  sha256: string;
  byteLength: number;
}>;

type CanaryPlan = Readonly<{
  schemaVersion: 1;
  protocolId: "HACC-VTR-v1";
  experimentId: "usefulness-live-canary-v7";
  createdAt: string;
  sourceCommit: string;
  sourceTree: string;
  suiteSha256: string;
  cells: readonly CanaryCell[];
  fixtures: readonly FixtureEntry[];
  fixtureManifestSha256: string;
  signer: Readonly<{ keyId: string; publicKeyPem: string; publicKeySha256: string }>;
  maximumSessions: 18;
  maximumReservationUsdPerSession: "1";
  maximumAggregateReservationUsd: "18";
  planSha256: string;
}>;

type CanarySummary = Readonly<{
  runId: string;
  pairId: string;
  provider: LiveStsProvider;
  family: UsefulnessDevelopmentTask["family"];
  condition: CanaryCondition;
  status: string;
  callerScheduleStatus: string | null;
  turnsPlanned: number;
  turnsSent: number;
  outputAudioTurns: number;
  transportTerminal: boolean;
  worldOutcomePass: boolean;
  systemIntegrityPass: boolean;
  estimatedCostUsd: number | null;
  artifactSha256: string;
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
  if (status) throw new Error("live usefulness canary requires a clean checkout");
  return { commit, tree };
}

function shortTask(family: UsefulnessDevelopmentTask["family"]): UsefulnessDevelopmentTask {
  const task = USEFULNESS_DEVELOPMENT_TASKS.find((candidate) =>
    candidate.family === family && candidate.complexity_band === "short"
  );
  if (!task) throw new Error(`missing short usefulness task for ${family}`);
  return task;
}

function cells(): readonly CanaryCell[] {
  const pairs = PROVIDERS.flatMap((provider) => ["museum", "campus", "water"].map((family) => ({
    provider,
    family: family as UsefulnessDevelopmentTask["family"],
    pairId: `vtr-canary-${provider}-${family}`,
  })));
  let ordinal = 0;
  return Object.freeze(pairs.flatMap((pair) => {
    const rawFirst = Number.parseInt(sha256Hex(pair.pairId).slice(-2), 16) % 2 === 0;
    const order = rawFirst ? CONDITIONS : Object.freeze([...CONDITIONS].reverse()) as readonly CanaryCondition[];
    return order.map((condition) => Object.freeze({
      ordinal: ++ordinal,
      pairId: pair.pairId,
      runId: `${pair.pairId}-${condition}`,
      provider: pair.provider,
      family: pair.family,
      condition,
    }));
  }));
}

async function generateFixtures(root: string): Promise<readonly FixtureEntry[]> {
  const tasks = ["museum", "campus", "water"].map((family) => shortTask(family as UsefulnessDevelopmentTask["family"]));
  const entries: FixtureEntry[] = [];
  const temporaryRoot = resolve(root, "fixture-work");
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  let ordinal = 0;
  try {
    for (const task of tasks) {
      for (const turn of task.scenario.caller.turns) {
        ordinal += 1;
        const aiff = resolve(temporaryRoot, `${String(ordinal).padStart(3, "0")}.aiff`);
        await execFile("say", ["-v", "Samantha", "-r", "180", "-o", aiff, turn.utterance]);
        for (const sampleRateHz of [16_000, 24_000] as const) {
          const relative = `fixtures/${task.family}/${sampleRateHz}/${turn.id}.pcm`;
          const destination = resolve(root, relative);
          await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
          await execFile("ffmpeg", [
            "-nostdin", "-loglevel", "error", "-y", "-i", aiff,
            "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", String(sampleRateHz), destination,
          ]);
          const bytes = new Uint8Array(await readFile(destination));
          entries.push(Object.freeze({
            taskSha256: task.suite_sha256,
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
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  return Object.freeze(entries);
}

async function prepare(root: string): Promise<void> {
  const source = await sourceState();
  try {
    await stat(root);
    throw new Error(`canary root already exists: ${root}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(root, { recursive: false, mode: 0o700 });
  const fixtures = await generateFixtures(root);
  const keys = generateKeyPairSync("ed25519");
  const privateKeyPem = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicKeyPem = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
  const signer = createBenchmarkKernelAttestationSigner({
    keyId: "usefulness-canary-v7",
    privateKeyPem,
    publicKeyPem,
  });
  const body = Object.freeze({
    schemaVersion: 1 as const,
    protocolId: "HACC-VTR-v1" as const,
    experimentId: "usefulness-live-canary-v7" as const,
    createdAt: new Date().toISOString(),
    sourceCommit: source.commit,
    sourceTree: source.tree,
    suiteSha256: USEFULNESS_DEVELOPMENT_SUITE_SHA256,
    cells: cells(),
    fixtures,
    fixtureManifestSha256: sha256Hex(canonicalJson(fixtures)),
    signer: Object.freeze({
      keyId: signer.keyId,
      publicKeyPem,
      publicKeySha256: signer.publicKeySha256,
    }),
    maximumSessions: 18 as const,
    maximumReservationUsdPerSession: "1" as const,
    maximumAggregateReservationUsd: "18" as const,
  });
  const plan: CanaryPlan = Object.freeze({ ...body, planSha256: sha256Hex(canonicalJson(body)) });
  await writeFile(resolve(root, PRIVATE_KEY_FILE), privateKeyPem, { flag: "wx", mode: 0o600 });
  await writeFile(resolve(root, PLAN_FILE), `${canonicalJson(plan)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(root, 0o700);
  process.stdout.write(`${canonicalJson({ action: "prepared", root, planSha256: plan.planSha256, sessions: plan.cells.length })}\n`);
}

async function loadPlan(root: string): Promise<CanaryPlan> {
  const plan = JSON.parse(await readFile(resolve(root, PLAN_FILE), "utf8")) as CanaryPlan;
  const { planSha256, ...body } = plan;
  if (sha256Hex(canonicalJson(body)) !== planSha256) throw new Error("canary plan hash mismatch");
  if (plan.suiteSha256 !== USEFULNESS_DEVELOPMENT_SUITE_SHA256) throw new Error("usefulness suite changed after prepare");
  if (canonicalJson(plan.cells) !== canonicalJson(cells())) throw new Error("canary schedule changed after prepare");
  const source = await sourceState();
  if (source.commit !== plan.sourceCommit || source.tree !== plan.sourceTree) throw new Error("source changed after canary prepare");
  return plan;
}

async function verifyFixtures(root: string, plan: CanaryPlan): Promise<void> {
  for (const entry of plan.fixtures) {
    if (!SAFE_PATH.test(entry.path) || entry.path.split("/").some((part) => part === "." || part === "..")) {
      throw new Error(`unsafe fixture path ${entry.path}`);
    }
    const path = resolve(root, entry.path);
    if (!path.startsWith(`${root}${sep}`)) throw new Error(`fixture escapes root: ${entry.path}`);
    const bytes = new Uint8Array(await readFile(path));
    if (bytes.byteLength !== entry.byteLength || sha256Hex(bytes) !== entry.sha256) {
      throw new Error(`fixture mismatch: ${entry.path}`);
    }
  }
}

async function callerAudio(root: string, plan: CanaryPlan, cell: CanaryCell, task: UsefulnessDevelopmentTask) {
  const rate = LIVE_STS_PROVIDER_SPECS[cell.provider].sampleRateHz;
  const entries = new Map(plan.fixtures
    .filter((entry) => entry.taskSha256 === task.suite_sha256 && entry.sampleRateHz === rate)
    .map((entry) => [entry.turnId, entry]));
  const callerTurns: CallerAudioTurn[] = [];
  const references: Record<string, ReturnType<typeof audioReference>> = {};
  for (const turn of task.scenario.caller.turns) {
    const entry = entries.get(turn.id);
    if (!entry) throw new Error(`missing ${cell.provider}/${task.family}/${turn.id} fixture`);
    const bytes = new Uint8Array(await readFile(resolve(root, entry.path)));
    callerTurns.push(Object.freeze({
      turnId: turn.id,
      audio: Object.freeze({ encoding: "pcm16" as const, sampleRateHz: rate, channels: 1 as const, data: bytes }),
    }));
    references[turn.id] = audioReference(task, entry);
  }
  const manifestHash = sha256Hex(canonicalJson(plan.fixtures.filter((entry) =>
    entry.taskSha256 === task.suite_sha256 && entry.sampleRateHz === rate
  )));
  const audioIndex = freezeCallerAudioIndex({
    schema_version: 1,
    scenario_id: task.scenario.id,
    scenario_version: task.scenario.version,
    fixture_set_id: `caf_${task.suite_sha256.slice(0, 24)}`,
    fixture_manifest_sha256: manifestHash,
    rendition: rate === 16_000 ? "pcm16le_mono_16000" : "pcm16le_mono_24000",
    turns: Object.fromEntries(Object.entries(references).map(([turnId, reference]) => [turnId, {
      ...reference,
      fixture_manifest_sha256: manifestHash,
    }])),
  });
  return { callerTurns: Object.freeze(callerTurns), audioIndex };
}

function audioReference(task: UsefulnessDevelopmentTask, entry: FixtureEntry) {
  return {
    turn_id: entry.turnId,
    fixture_set_id: `caf_${task.suite_sha256.slice(0, 24)}`,
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

function estimatedCost(provider: LiveStsProvider, metrics: Readonly<{
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

async function runCell(root: string, plan: CanaryPlan, cell: CanaryCell, apiKey: string): Promise<void> {
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
    throw new Error(`partial run exists and no-retry policy blocks continuation: ${cell.runId}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(partial, { recursive: false, mode: 0o700 });
  await writeFile(resolve(partial, "scheduled.json"), `${canonicalJson({
    schemaVersion: 1,
    protocolId: plan.protocolId,
    planSha256: plan.planSha256,
    cell,
    scheduledAt: plan.createdAt,
  })}\n`, { flag: "wx", mode: 0o600 });
  const task = shortTask(cell.family);
  const suite = compileConditionSuite(task.compiler_input);
  const condition = suite.conditions[cell.condition as BenchmarkConditionId];
  const loaded = await callerAudio(root, plan, cell, task);
  const pairedAudio = createPairedAudioManifest({ pairId: cell.pairId, scenario: task.scenario, callerTurns: loaded.callerTurns });
  const pairInvariantsHash = sha256Hex(`hacc-vtr/live-canary-pair/v1\n${canonicalJson({
    planSha256: plan.planSha256,
    pairId: cell.pairId,
    provider: cell.provider,
    model: LIVE_STS_PROVIDER_SPECS[cell.provider].model,
    taskSha256: task.suite_sha256,
    audio: pairedAudio,
  })}`);
  const cellPlanSha256 = sha256Hex(`hacc-vtr/live-canary-cell/v1\n${canonicalJson({
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
  const spec = LIVE_STS_PROVIDER_SPECS[cell.provider];
  const evidenceBinding: BenchmarkKernelEvidenceBinding = Object.freeze({
    pairId: cell.pairId,
    leaseSubjectId: cell.pairId,
    provider: cell.provider,
    model: spec.model,
    planSha256: cellPlanSha256,
    freezeLockSha256: plan.planSha256,
    kernelBuildSha256: sha256Hex(`git-tree\n${plan.sourceTree}`),
  });
  const gatewayKernel = new InMemoryBenchmarkGatewayKernel({
    flow: AgentFlowSchema.parse(task.compiler_input.flow),
    expectedFlowHash: suite.flowHash,
    expectedScenarioHash: suite.scenarioHash,
    expectedConditionHash: condition.conditionHash,
    grantBindingHash: suite.sourceHash,
    leaseSubjectId: cell.pairId,
    evidenceBinding,
    signer,
    capabilitySecret: sha256Hex(`usefulness-canary-capability\n${plan.planSha256}\n${cell.runId}`),
    leaseTtlSeconds: 6 * 60,
  });
  let summary: CanarySummary;
  try {
    const inputBytes = loaded.callerTurns.reduce((total, turn) => total + (
      Array.isArray(turn.audio)
        ? turn.audio.reduce((turnTotal, segment) => turnTotal + segment.data.byteLength, 0)
        : (turn.audio as { data: Uint8Array }).data.byteLength
    ), 0);
    const result = await runBenchmarkTrial({
      runId: cell.runId,
      provider: cell.provider,
      model: spec.model,
      scenario: task.scenario,
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
        task,
        run_id: cell.runId,
        created_at: plan.createdAt,
        audio: loaded.audioIndex,
      }),
      pairInvariantsHash,
      studyPlanHash: plan.planSha256,
      limits: {
        maxTurns: task.scenario.max_turns,
        maxSessionMs: 5 * 60_000,
        maxInputAudioBytes: inputBytes,
        maxOutputAudioBytes: 32 * 1024 * 1024,
        maxToolCalls: 64,
        sessionReadyTimeoutMs: 15_000,
        responseTimeoutMs: 45_000,
      },
      budget: {
        ledger: createBudgetLedger({ authorization_ceiling_usd: "1", scheduling_stop_usd: "1" }),
        reservationId: `${cell.runId}-reservation`,
        maximumUsd: "1",
        persistLedger: async () => undefined,
        estimateCost: (metrics) => ({ estimatedUsd: estimatedCost(cell.provider, metrics).toFixed(6) }),
      },
    });
    await persistArtifacts(partial, result);
    const evaluation = evaluateScenarioWorld(task.scenario, result.world);
    const reservation = result.budgetLedger.reservations.find((candidate) => candidate.reservation_id === `${cell.runId}-reservation`);
    summary = Object.freeze({
      runId: cell.runId,
      pairId: cell.pairId,
      provider: cell.provider,
      family: cell.family,
      condition: cell.condition,
      status: result.status,
      callerScheduleStatus: result.callerSchedule?.status ?? null,
      turnsPlanned: result.counters.turnsPlanned,
      turnsSent: result.counters.turnsSent,
      outputAudioTurns: result.providerEvidence.audio.output.length,
      transportTerminal: result.status === "completed" && result.callerSchedule?.status === "complete",
      worldOutcomePass: evaluation.success.every((assertion) => assertion.passed),
      systemIntegrityPass: evaluation.safety.every((assertion) => assertion.passed),
      estimatedCostUsd: reservation?.costs?.estimated_micro_usd == null
        ? null
        : reservation.costs.estimated_micro_usd / 1_000_000,
      artifactSha256: sha256Hex(result.artifacts.manifestJson),
    });
  } catch (error) {
    summary = Object.freeze({
      runId: cell.runId,
      pairId: cell.pairId,
      provider: cell.provider,
      family: cell.family,
      condition: cell.condition,
      status: "runner_exception",
      callerScheduleStatus: null,
      turnsPlanned: task.scenario.max_turns,
      turnsSent: 0,
      outputAudioTurns: 0,
      transportTerminal: false,
      worldOutcomePass: false,
      systemIntegrityPass: false,
      estimatedCostUsd: null,
      artifactSha256: sha256Hex(`runner-exception\n${cell.runId}`),
    });
    const rawMessage = error instanceof Error ? error.message : String(error);
    const safeMessage = rawMessage.replaceAll(apiKey, "[REDACTED]").slice(0, 2_000);
    await writeFile(resolve(partial, "runner-error.json"), `${canonicalJson({
      errorClass: error instanceof Error ? error.name : "NonErrorThrow",
      message: safeMessage,
      messageSha256: sha256Hex(rawMessage),
    })}\n`, { flag: "wx", mode: 0o600 });
  }
  await writeFile(resolve(partial, "summary.json"), `${canonicalJson(summary)}\n`, { flag: "wx", mode: 0o600 });
  await rename(partial, complete);
  process.stdout.write(`${canonicalJson({ action: "cell-retained", ordinal: cell.ordinal, runId: cell.runId, status: summary.status })}\n`);
}

async function run(root: string, concurrency: number): Promise<void> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 6) throw new Error("concurrency must be 1..6");
  const plan = await loadPlan(root);
  await verifyFixtures(root, plan);
  const credentials = await loadProductionRealtimeCredentials(REPOSITORY_ROOT);
  await mkdir(resolve(root, "runs"), { recursive: true, mode: 0o700 });
  const selectedRunId = option("run-id");
  const selectedCells = selectedRunId
    ? plan.cells.filter((cell) => cell.runId === selectedRunId)
    : plan.cells;
  if (selectedCells.length === 0) throw new Error(`run-id is not present in the frozen plan: ${selectedRunId}`);
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= selectedCells.length) return;
      const cell = selectedCells[index];
      await runCell(root, plan, cell, credentials[cell.provider]);
    }
  }));
}

async function report(root: string): Promise<void> {
  const plan = await loadPlan(root);
  const summaries = await Promise.all(plan.cells.map(async (cell) => JSON.parse(await readFile(
    resolve(root, "runs", `${cell.runId}.complete`, "summary.json"),
    "utf8",
  )) as CanarySummary));
  const groups = PROVIDERS.flatMap((provider) => CONDITIONS.map((condition) => {
    const values = summaries.filter((summary) => summary.provider === provider && summary.condition === condition);
    return Object.freeze({
      provider,
      condition,
      scheduled: values.length,
      transportTerminal: values.filter((value) => value.transportTerminal).length,
      worldOutcomePass: values.filter((value) => value.worldOutcomePass).length,
      systemIntegrityPass: values.filter((value) => value.systemIntegrityPass).length,
      turnsSent: values.reduce((total, value) => total + value.turnsSent, 0),
      estimatedCostUsd: values.reduce((total, value) => total + (value.estimatedCostUsd ?? 0), 0),
    });
  }));
  const result = Object.freeze({
    schemaVersion: 1,
    protocolId: plan.protocolId,
    experimentId: plan.experimentId,
    planSha256: plan.planSha256,
    sourceCommit: plan.sourceCommit,
    suiteSha256: plan.suiteSha256,
    scheduledEpisodes: plan.cells.length,
    completedVoiceTurns: summaries.reduce((total, summary) => total + Math.min(summary.turnsSent, summary.outputAudioTurns), 0),
    groups,
    claimBoundary: "development transport and world-outcome canary; audio-semantic criteria remain unverified",
  });
  const withHash = Object.freeze({ ...result, resultSha256: sha256Hex(canonicalJson(result)) });
  await writeFile(resolve(root, "canary-result.json"), `${canonicalJson(withHash)}\n`, { mode: 0o600 });
  const markdown = [
    "# Useful voice task live canary",
    "",
    `- Result SHA-256: \`${withHash.resultSha256}\``,
    `- Scheduled episodes: **${withHash.scheduledEpisodes}**`,
    `- Completed voice-to-voice turns: **${withHash.completedVoiceTurns}**`,
    "- Claim boundary: development transport and world-outcome canary; independent audio-semantic criteria are not yet scored.",
    "",
    "| Provider | Condition | Terminal sessions | World task passes | System integrity | Estimated cost |",
    "|---|---|---:|---:|---:|---:|",
    ...groups.map((group) => `| ${group.provider} | ${group.condition} | ${group.transportTerminal}/${group.scheduled} | ${group.worldOutcomePass}/${group.scheduled} | ${group.systemIntegrityPass}/${group.scheduled} | $${group.estimatedCostUsd.toFixed(4)} |`),
    "",
  ].join("\n");
  await writeFile(resolve(root, "canary-result.md"), markdown, { mode: 0o600 });
  process.stdout.write(`${canonicalJson({ action: "reported", resultSha256: withHash.resultSha256, groups })}\n`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const root = rootDirectory();
  if (command === "prepare") return prepare(root);
  if (command === "run") return run(root, Number(option("concurrency") ?? "3"));
  if (command === "report") return report(root);
  throw new Error("usage: usefulness-live-canary <prepare|run|report> [--root DIR] [--concurrency 1..6] [--run-id ID]");
}

main().catch((error) => {
  process.stderr.write(`${canonicalJson({ errorClass: error instanceof Error ? error.name : "NonErrorThrow", message: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
});
