#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { canonicalJson, sha256Hex } from "../lib/benchmark/artifacts";
import { AgentFlowSchema } from "../lib/flow";
import { createBudgetLedger } from "../lib/benchmark/budget";
import { compileConditionSuite } from "../lib/benchmark/condition-compiler";
import { InMemoryBenchmarkGatewayKernel } from "../lib/benchmark/gateway-kernel";
import {
  createBenchmarkKernelAttestationSigner,
  type BenchmarkKernelEvidenceBinding,
} from "../lib/benchmark/kernel-attestation";
import {
  LIVE_STS_EXPERIMENT_ID,
  LIVE_STS_PROVIDER_SPECS,
  LIVE_STS_TURNS_PER_SESSION,
  createLiveStsCells,
  liveStsScheduleArtifact,
  scoreLiveStsRuns,
  type LiveStsCell,
  type LiveStsFamily,
  type LiveStsProvider,
  type LiveStsRunSummary,
} from "../lib/benchmark/live-sts-development-experiment";
import { LONG_HORIZON_SCENARIO_SUITE } from "../lib/benchmark/long-horizon-scenario-suite";
import {
  createPairedAudioManifest,
  runBenchmarkTrial,
  type CallerAudioTurn,
  type TrialSessionConfiguration,
} from "../lib/benchmark/orchestrator";
import { evaluateScenarioWorld } from "../lib/benchmark/tool-world";
import { GeminiLiveClient } from "../lib/realtime/client/gemini-live";
import {
  createOpenAIRealtimeClient,
  createXaiRealtimeClient,
} from "../lib/realtime/client/openai-compatible";
import type { NormalizedRealtimeClient } from "../lib/realtime/client/types";

const execFile = promisify(execFileCallback);
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_ROOT = resolve(REPOSITORY_ROOT, "benchmarks/voice-long-horizon/.local/live-sts-development-v1");
const PRIVATE_KEY_FILE = "operator-ed25519.private.pem";
const PLAN_FILE = "experiment-plan.json";
const RESULT_FILE = "experiment-results.json";
const REPORT_FILE = "experiment-results.md";
const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

type FixtureEntry = Readonly<{
  family: LiveStsFamily;
  scenarioId: string;
  turnId: string;
  utteranceSha256: string;
  sampleRateHz: 16_000 | 24_000;
  path: string;
  sha256: string;
  byteLength: number;
  durationMs: number;
}>;

type ExperimentPlan = Readonly<{
  schemaVersion: 1;
  experimentId: typeof LIVE_STS_EXPERIMENT_ID;
  createdAt: string;
  sourceCommit: string;
  sourceTree: string;
  schedule: ReturnType<typeof liveStsScheduleArtifact>;
  scenarios: readonly Readonly<{
    family: LiveStsFamily;
    id: string;
    version: string;
    canonicalSha256: string;
    conditionSuiteSha256: string;
  }>[];
  fixture: Readonly<{
    kind: "synthetic-caller-speech";
    voice: "Samantha";
    speechRateWordsPerMinute: 210;
    generator: Readonly<{ macos: string; ffmpeg: string }>;
    entries: readonly FixtureEntry[];
    manifestSha256: string;
  }>;
  signer: Readonly<{
    keyId: string;
    publicKeyPem: string;
    publicKeySha256: string;
  }>;
  execution: Readonly<{
    maximumSessions: 32;
    maximumReservationUsdPerSession: "5";
    maximumAggregateReservationUsd: "160";
    noRetries: true;
    rawComparator: string;
    claimBoundary: string;
  }>;
  planSha256: string;
}>;

function usage(): never {
  throw new Error("usage: live-sts-development-experiment <prepare|run|score> [--root DIR] [--concurrency 1..8]");
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) usage();
  return value;
}

function rootDirectory(): string {
  return resolve(option("root") ?? DEFAULT_ROOT);
}

async function git(...args: string[]): Promise<string> {
  const result = await execFile("git", args, { cwd: REPOSITORY_ROOT, maxBuffer: 16 * 1024 * 1024 });
  return result.stdout.trim();
}

async function assertCleanSource(expected?: Pick<ExperimentPlan, "sourceCommit" | "sourceTree">): Promise<{ commit: string; tree: string }> {
  const [status, commit, tree] = await Promise.all([
    git("status", "--porcelain"),
    git("rev-parse", "HEAD"),
    git("rev-parse", "HEAD^{tree}"),
  ]);
  if (status) throw new Error("live provider experiment requires a clean checkout");
  if (expected && (commit !== expected.sourceCommit || tree !== expected.sourceTree)) {
    throw new Error("live provider experiment source differs from the frozen plan");
  }
  return { commit, tree };
}

function template(family: LiveStsFamily) {
  const found = LONG_HORIZON_SCENARIO_SUITE.find((candidate) => (
    candidate.family === family
    && candidate.turnCount === LIVE_STS_TURNS_PER_SESSION
    && candidate.studyRole === "development"
    && candidate.executionEligibility === "development-provider-eligible"
  ));
  if (!found) throw new Error(`missing provider-eligible ${family} 32-turn template`);
  return found;
}

async function writeExclusive(path: string, value: string | Uint8Array, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, value, { flag: "wx", mode });
}

async function writeCanonicalExclusive(path: string, value: unknown): Promise<void> {
  await writeExclusive(path, `${canonicalJson(value)}\n`);
}

async function mapConcurrent<T, R>(values: readonly T[], concurrency: number, task: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      results[index] = await task(values[index], index);
    }
  }));
  return results;
}

async function commandVersion(command: string, args: string[]): Promise<string> {
  const result = await execFile(command, args, { maxBuffer: 1024 * 1024 });
  return `${result.stdout}${result.stderr}`.trim().split("\n")[0] ?? "unknown";
}

async function generateFixtures(root: string): Promise<readonly FixtureEntry[]> {
  const work = ["field-service-escalation", "travel-disruption"].flatMap((family) => (
    template(family as LiveStsFamily).scenario.caller.turns.map((turn) => ({
      family: family as LiveStsFamily,
      scenarioId: template(family as LiveStsFamily).scenario.id,
      turnId: turn.id,
      utterance: turn.utterance,
    }))
  ));
  const fixtureRoot = resolve(root, "fixtures");
  await mkdir(fixtureRoot, { recursive: true, mode: 0o700 });
  const entries = await mapConcurrent(work, 4, async (item, index) => {
    const stem = `${String(index + 1).padStart(3, "0")}-${sha256Hex(item.turnId).slice(0, 12)}`;
    const temporaryAiff = resolve(fixtureRoot, `${stem}.aiff`);
    await execFile("say", ["-v", "Samantha", "-r", "210", "-o", temporaryAiff, item.utterance]);
    const produced: FixtureEntry[] = [];
    try {
      for (const sampleRateHz of [16_000, 24_000] as const) {
        const relativePath = `fixtures/${item.family}/${sampleRateHz}/${item.turnId}.pcm`;
        const destination = resolve(root, relativePath);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await execFile("ffmpeg", [
          "-nostdin", "-loglevel", "error", "-y", "-i", temporaryAiff,
          "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", String(sampleRateHz), destination,
        ], { maxBuffer: 4 * 1024 * 1024 });
        const bytes = new Uint8Array(await readFile(destination));
        if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0) {
          throw new Error(`invalid generated PCM for ${item.turnId} at ${sampleRateHz}`);
        }
        produced.push(Object.freeze({
          family: item.family,
          scenarioId: item.scenarioId,
          turnId: item.turnId,
          utteranceSha256: sha256Hex(item.utterance),
          sampleRateHz,
          path: relativePath,
          sha256: sha256Hex(bytes),
          byteLength: bytes.byteLength,
          durationMs: bytes.byteLength / 2 / sampleRateHz * 1_000,
        }));
      }
    } finally {
      await rm(temporaryAiff, { force: true });
    }
    return produced;
  });
  return Object.freeze(entries.flat().sort((left, right) => (
    `${left.family}/${left.turnId}/${left.sampleRateHz}`.localeCompare(`${right.family}/${right.turnId}/${right.sampleRateHz}`)
  )));
}

async function prepare(root: string): Promise<void> {
  const source = await assertCleanSource();
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    await stat(resolve(root, PLAN_FILE));
    throw new Error(`experiment plan already exists at ${resolve(root, PLAN_FILE)}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const fixtureEntries = await generateFixtures(root);
  const fixtureWithoutHash = Object.freeze({
    kind: "synthetic-caller-speech" as const,
    voice: "Samantha" as const,
    speechRateWordsPerMinute: 210 as const,
    generator: Object.freeze({
      macos: await commandVersion("sw_vers", ["-productVersion"]),
      ffmpeg: await commandVersion("ffmpeg", ["-version"]),
    }),
    entries: fixtureEntries,
  });
  const fixture = Object.freeze({
    ...fixtureWithoutHash,
    manifestSha256: sha256Hex(`harshas-amazing-call-center/live-sts-fixture/v1\n${canonicalJson(fixtureWithoutHash)}`),
  });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const signer = createBenchmarkKernelAttestationSigner({
    keyId: "live-sts-development-v1",
    privateKeyPem,
    publicKeyPem,
  });
  await writeExclusive(resolve(root, PRIVATE_KEY_FILE), privateKeyPem, 0o600);
  await chmod(resolve(root, PRIVATE_KEY_FILE), 0o600);
  const scenarios = (["field-service-escalation", "travel-disruption"] as const).map((family) => {
    const sourceTemplate = template(family);
    const suite = compileConditionSuite(sourceTemplate.compilerInput);
    return Object.freeze({
      family,
      id: sourceTemplate.scenario.id,
      version: sourceTemplate.scenario.version,
      canonicalSha256: sha256Hex(canonicalJson(sourceTemplate.scenario)),
      conditionSuiteSha256: suite.suiteHash,
    });
  });
  const withoutHash = Object.freeze({
    schemaVersion: 1 as const,
    experimentId: LIVE_STS_EXPERIMENT_ID,
    createdAt: new Date().toISOString(),
    sourceCommit: source.commit,
    sourceTree: source.tree,
    schedule: liveStsScheduleArtifact(),
    scenarios: Object.freeze(scenarios),
    fixture,
    signer: Object.freeze({
      keyId: signer.keyId,
      publicKeyPem,
      publicKeySha256: signer.publicKeySha256,
    }),
    execution: Object.freeze({
      maximumSessions: 32 as const,
      maximumReservationUsdPerSession: "5" as const,
      maximumAggregateReservationUsd: "160" as const,
      noRetries: true as const,
      rawComparator: "raw-full is monolithic all-actions prompting behind the identical local capability gateway",
      claimBoundary: "exploratory development benchmark; synthetic caller speech; API models, not consumer voice products; no statistical-superiority claim",
    }),
  });
  const plan: ExperimentPlan = Object.freeze({
    ...withoutHash,
    planSha256: sha256Hex(`harshas-amazing-call-center/live-sts-development-plan/v1\n${canonicalJson(withoutHash)}`),
  });
  await writeCanonicalExclusive(resolve(root, PLAN_FILE), plan);
  process.stdout.write(`${canonicalJson({
    action: "prepared",
    root,
    planSha256: plan.planSha256,
    scheduleSha256: plan.schedule.scheduleSha256,
    fixtureManifestSha256: plan.fixture.manifestSha256,
    sessions: plan.schedule.sessions,
    plannedVoiceToVoiceInteractions: plan.schedule.plannedVoiceToVoiceInteractions,
    providerCalls: 0,
  })}\n`);
}

function parsePlan(value: unknown): ExperimentPlan {
  if (!value || typeof value !== "object") throw new Error("experiment plan is not an object");
  const plan = value as ExperimentPlan;
  const { planSha256, ...withoutHash } = plan;
  const expected = sha256Hex(`harshas-amazing-call-center/live-sts-development-plan/v1\n${canonicalJson(withoutHash)}`);
  if (planSha256 !== expected || plan.experimentId !== LIVE_STS_EXPERIMENT_ID) {
    throw new Error("experiment plan hash or identity is invalid");
  }
  if (canonicalJson(plan.schedule) !== canonicalJson(liveStsScheduleArtifact())) {
    throw new Error("experiment schedule differs from the source-frozen schedule");
  }
  return plan;
}

async function loadPlan(root: string): Promise<ExperimentPlan> {
  return parsePlan(JSON.parse(await readFile(resolve(root, PLAN_FILE), "utf8")));
}

async function verifyFixtures(root: string, plan: ExperimentPlan): Promise<void> {
  for (const entry of plan.fixture.entries) {
    if (!SAFE_PATH.test(entry.path) || entry.path.split("/").some((part) => part === ".." || part === ".")) {
      throw new Error(`unsafe fixture path ${entry.path}`);
    }
    const path = resolve(root, entry.path);
    if (!path.startsWith(`${root}${sep}`)) throw new Error(`fixture path escapes root: ${entry.path}`);
    const bytes = new Uint8Array(await readFile(path));
    if (bytes.byteLength !== entry.byteLength || sha256Hex(bytes) !== entry.sha256) {
      throw new Error(`fixture integrity mismatch: ${entry.path}`);
    }
  }
}

function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

async function providerKeys(): Promise<Readonly<Record<LiveStsProvider, string>>> {
  const candidates = [
    resolve(REPOSITORY_ROOT, "web/.env.local"),
    "/Users/harsha/Desktop/gpu-hub-harness/.secrets/staging-runtime-provider.env",
  ];
  const merged: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const path of candidates) {
    try {
      Object.assign(merged, parseEnv(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const required = {
    openai: merged.OPENAI_API_KEY,
    gemini: merged.GEMINI_API_KEY,
    xai: merged.XAI_API_KEY,
  };
  for (const [provider, key] of Object.entries(required)) {
    if (!key || key.length < 12) throw new Error(`missing ${provider} provider credential`);
  }
  return Object.freeze(required as Record<LiveStsProvider, string>);
}

function createClient(provider: LiveStsProvider, configuration: TrialSessionConfiguration, apiKey: string): NormalizedRealtimeClient {
  const spec = LIVE_STS_PROVIDER_SPECS[provider];
  if (provider === "gemini") {
    return new GeminiLiveClient({
      apiKey,
      model: spec.model,
      voice: spec.voice,
      instructions: configuration.instructions,
      tools: configuration.providerTools,
      connectTimeoutMs: 15_000,
      maximumSessionDurationMs: 10 * 60_000,
    });
  }
  const sessionUpdate = provider === "openai"
    ? {
        type: "session.update",
        session: {
          type: "realtime",
          model: spec.model,
          instructions: configuration.instructions,
          audio: { input: { transcription: null, turn_detection: null }, output: { voice: spec.voice } },
          tools: configuration.providerTools,
          tool_choice: "auto",
        },
      }
    : {
        type: "session.update",
        session: {
          voice: spec.voice,
          instructions: configuration.instructions,
          turn_detection: { type: null },
          audio: { input: { transcription: null }, output: {} },
          tools: configuration.providerTools,
          tool_choice: "auto",
        },
      };
  return provider === "openai"
    ? createOpenAIRealtimeClient({
        apiKey,
        model: spec.model,
        sessionUpdate,
        connectTimeoutMs: 15_000,
        requireStrictSessionConfigurationParity: true,
      })
    : createXaiRealtimeClient({
        apiKey,
        model: spec.model,
        sessionUpdate,
        connectTimeoutMs: 15_000,
        enableResumption: false,
        // xAI does not echo voice or function schema details in session.updated;
        // the result artifact retains that limitation instead of claiming parity.
        requireStrictSessionConfigurationParity: false,
      });
}

async function callerTurns(root: string, plan: ExperimentPlan, cell: LiveStsCell): Promise<readonly CallerAudioTurn[]> {
  const sourceTemplate = template(cell.family);
  const rate = LIVE_STS_PROVIDER_SPECS[cell.provider].sampleRateHz;
  const byTurn = new Map(plan.fixture.entries
    .filter((entry) => entry.family === cell.family && entry.sampleRateHz === rate)
    .map((entry) => [entry.turnId, entry]));
  return Object.freeze(await Promise.all(sourceTemplate.scenario.caller.turns.map(async (turn) => {
    const entry = byTurn.get(turn.id);
    if (!entry) throw new Error(`missing fixture for ${cell.family}/${turn.id}/${rate}`);
    return Object.freeze({
      turnId: turn.id,
      audio: Object.freeze({
        encoding: "pcm16" as const,
        sampleRateHz: rate,
        channels: 1 as const,
        data: new Uint8Array(await readFile(resolve(root, entry.path))),
      }),
    });
  })));
}

async function persistArtifacts(root: string, result: Awaited<ReturnType<typeof runBenchmarkTrial>>): Promise<void> {
  for (const file of result.artifacts.files) {
    if (!SAFE_PATH.test(file.path) || file.path.split("/").some((part) => part === "." || part === "..")) {
      throw new Error(`unsafe result artifact path ${file.path}`);
    }
    const destination = resolve(root, "artifacts", file.path);
    if (!destination.startsWith(`${resolve(root, "artifacts")}${sep}`)) throw new Error("result artifact path escapes run root");
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const bytes = typeof file.content === "string" ? file.content : file.content;
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
  }
  await writeExclusive(resolve(root, "artifacts/runner-manifest.json"), result.artifacts.manifestJson);
}

async function runCell(root: string, plan: ExperimentPlan, cell: LiveStsCell, apiKey: string): Promise<void> {
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
  await writeCanonicalExclusive(resolve(partial, "started.json"), {
    schemaVersion: 1,
    experimentPlanSha256: plan.planSha256,
    scheduleSha256: plan.schedule.scheduleSha256,
    cell,
    startedAt: new Date().toISOString(),
  });
  const sourceTemplate = template(cell.family);
  const suite = compileConditionSuite(sourceTemplate.compilerInput);
  const condition = suite.conditions[cell.condition];
  const audio = await callerTurns(root, plan, cell);
  const pairedAudio = createPairedAudioManifest({
    pairId: cell.pairId,
    scenario: sourceTemplate.scenario,
    callerTurns: audio,
  });
  const pairInvariantsHash = sha256Hex(`harshas-amazing-call-center/live-sts-pair/v1\n${canonicalJson({
    experimentPlanSha256: plan.planSha256,
    pairId: cell.pairId,
    provider: cell.provider,
    model: LIVE_STS_PROVIDER_SPECS[cell.provider].model,
    family: cell.family,
    audio: pairedAudio,
  })}`);
  const cellPlanSha256 = sha256Hex(`harshas-amazing-call-center/live-sts-cell/v1\n${canonicalJson({
    experimentPlanSha256: plan.planSha256,
    cell,
    conditionHash: condition.conditionHash,
    pairInvariantsHash,
  })}`);
  const privateKeyPem = await readFile(resolve(root, PRIVATE_KEY_FILE), "utf8");
  const signer = createBenchmarkKernelAttestationSigner({
    keyId: plan.signer.keyId,
    privateKeyPem,
    publicKeyPem: plan.signer.publicKeyPem,
  });
  if (signer.publicKeySha256 !== plan.signer.publicKeySha256) throw new Error("experiment signer fingerprint mismatch");
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
    flow: AgentFlowSchema.parse(sourceTemplate.compilerInput.flow),
    expectedFlowHash: suite.flowHash,
    expectedScenarioHash: suite.scenarioHash,
    expectedConditionHash: condition.conditionHash,
    grantBindingHash: suite.sourceHash,
    leaseSubjectId: cell.pairId,
    evidenceBinding,
    signer,
    capabilitySecret: sha256Hex(`live-sts-private-capability\n${plan.planSha256}\n${cell.runId}`),
    leaseTtlSeconds: 11 * 60,
  });
  let summary: LiveStsRunSummary;
  try {
    const inputBytes = audio.reduce((sum, turn) => sum + (turn.audio as { data: Uint8Array }).data.byteLength, 0);
    const result = await runBenchmarkTrial({
      runId: cell.runId,
      provider: cell.provider,
      model: spec.model,
      scenario: sourceTemplate.scenario,
      createClient: (configuration) => createClient(cell.provider, configuration, apiKey),
      condition,
      gatewayKernel,
      kernelAttestationExpectation: Object.freeze({
        evidenceBinding,
        trust: Object.freeze({
          keyId: plan.signer.keyId,
          publicKeySha256: plan.signer.publicKeySha256,
          publicKeyPem: plan.signer.publicKeyPem,
        }),
      }),
      journalSecretValues: [apiKey],
      callerTurns: audio,
      pairedAudio,
      pairInvariantsHash,
      studyPlanHash: plan.planSha256,
      limits: Object.freeze({
        maxTurns: LIVE_STS_TURNS_PER_SESSION,
        maxSessionMs: 10 * 60_000,
        maxInputAudioBytes: inputBytes,
        maxOutputAudioBytes: 64 * 1024 * 1024,
        maxToolCalls: 200,
        sessionReadyTimeoutMs: 15_000,
        responseTimeoutMs: 45_000,
      }),
      budget: {
        ledger: createBudgetLedger({ authorization_ceiling_usd: "5", scheduling_stop_usd: "5" }),
        reservationId: `${cell.runId}-reservation`,
        maximumUsd: "5",
        persistLedger: async () => undefined,
        estimateCost: () => ({ estimatedUsd: "5" }),
      },
    });
    await persistArtifacts(partial, result);
    const evaluation = evaluateScenarioWorld(sourceTemplate.scenario, result.world);
    summary = Object.freeze({
      runId: cell.runId,
      pairId: cell.pairId,
      provider: cell.provider,
      family: cell.family,
      condition: cell.condition,
      status: result.status,
      turnsPlanned: result.counters.turnsPlanned,
      turnsSent: result.counters.turnsSent,
      outputAudioTurns: result.providerEvidence.audio.output.length,
      taskSuccess: evaluation.task_success,
      safetyPassed: evaluation.safety.every((assertion) => assertion.passed),
      artifactSha256: sha256Hex(result.artifacts.manifestJson),
    });
  } catch (error) {
    await writeCanonicalExclusive(resolve(partial, "runner-error.json"), {
      schemaVersion: 1,
      runId: cell.runId,
      errorClass: error instanceof Error ? error.name : "NonErrorThrow",
      messageSha256: sha256Hex(error instanceof Error ? error.message : String(error)),
      recordedAt: new Date().toISOString(),
    });
    summary = Object.freeze({
      runId: cell.runId,
      pairId: cell.pairId,
      provider: cell.provider,
      family: cell.family,
      condition: cell.condition,
      status: "runner_exception",
      turnsPlanned: LIVE_STS_TURNS_PER_SESSION,
      turnsSent: 0,
      outputAudioTurns: 0,
      taskSuccess: false,
      safetyPassed: false,
      artifactSha256: sha256Hex(`runner-exception\n${cell.runId}`),
    });
  }
  await writeCanonicalExclusive(resolve(partial, "summary.json"), summary);
  await rename(partial, complete);
  process.stdout.write(`${canonicalJson({ action: "cell-retained", ordinal: cell.ordinal, runId: cell.runId, status: summary.status })}\n`);
}

async function run(root: string, concurrency: number): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("concurrency must be from 1 through 8");
  const plan = await loadPlan(root);
  await assertCleanSource(plan);
  await verifyFixtures(root, plan);
  const keys = await providerKeys();
  const cells = createLiveStsCells();
  if (cells.length !== plan.execution.maximumSessions) throw new Error("scheduled session count exceeds frozen maximum");
  await mkdir(resolve(root, "runs"), { recursive: true, mode: 0o700 });
  await mapConcurrent(cells, concurrency, async (cell) => runCell(root, plan, cell, keys[cell.provider]));
  process.stdout.write(`${canonicalJson({ action: "batch-retained", sessions: cells.length, scoresOpened: false })}\n`);
}

async function loadRunSummaries(root: string): Promise<LiveStsRunSummary[]> {
  return Promise.all(createLiveStsCells().map(async (cell) => JSON.parse(await readFile(
    resolve(root, "runs", `${cell.runId}.complete`, "summary.json"),
    "utf8",
  )) as LiveStsRunSummary));
}

async function score(root: string): Promise<void> {
  const plan = await loadPlan(root);
  await assertCleanSource(plan);
  const scored = scoreLiveStsRuns(await loadRunSummaries(root));
  const result = Object.freeze({
    ...scored,
    experimentPlanSha256: plan.planSha256,
    scheduleSha256: plan.schedule.scheduleSha256,
    fixtureManifestSha256: plan.fixture.manifestSha256,
    sourceCommit: plan.sourceCommit,
    sourceTree: plan.sourceTree,
  });
  await writeCanonicalExclusive(resolve(root, RESULT_FILE), result);
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
  const report = [
    "# Live STS long-flow development result",
    "",
    `- Result SHA-256: \`${scored.resultSha256}\``,
    `- Source commit: \`${plan.sourceCommit}\``,
    `- Sessions: **${scored.sessions}** (${scored.matchedPairs} matched pairs)`,
    `- Completed voice-to-voice interactions: **${scored.voiceToVoiceInteractions.toLocaleString("en-US")}** / ${scored.plannedInteractions.toLocaleString("en-US")}`,
    "- Caller audio: deterministic macOS Samantha TTS, paired byte-for-byte within each raw-full/full-harness provider pair",
    "- Comparator: raw-full is monolithic all-actions prompting behind the identical local capability gateway",
    "- Claim boundary: exploratory development API-model benchmark; not consumer ChatGPT Voice; no statistical-superiority or broad-production claim",
    "",
    "| Arm | Strict passes | Sessions | Pass rate |",
    "|---|---:|---:|---:|",
    ...[
      scored.scores.openaiRaw,
      scored.scores.geminiRaw,
      scored.scores.xaiRaw,
      scored.scores.harnessPooled,
      scored.scores.harnessByProvider.openai,
      scored.scores.harnessByProvider.gemini,
      scored.scores.harnessByProvider.xai,
    ].map((entry) => `| ${entry.label} | ${entry.passed} | ${entry.sessions} | ${percent(entry.passRate)} |`),
    "",
    `Strict pass requires: ${scored.strictDefinition}.`,
    "",
  ].join("\n");
  await writeExclusive(resolve(root, REPORT_FILE), report);
  process.stdout.write(`${canonicalJson({
    action: "scored",
    resultPath: resolve(root, RESULT_FILE),
    reportPath: resolve(root, REPORT_FILE),
    resultSha256: scored.resultSha256,
    voiceToVoiceInteractions: scored.voiceToVoiceInteractions,
    scores: scored.scores,
  })}\n`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const root = rootDirectory();
  if (command === "prepare") return prepare(root);
  if (command === "run") return run(root, Number(option("concurrency") ?? "4"));
  if (command === "score") return score(root);
  usage();
}

main().catch((error) => {
  process.stderr.write(`${canonicalJson({
    error: error instanceof Error ? error.message : String(error),
    errorClass: error instanceof Error ? error.name : "NonErrorThrow",
  })}\n`);
  process.exitCode = 1;
});
