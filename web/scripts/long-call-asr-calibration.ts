#!/usr/bin/env node

import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { canonicalJson, sha256Hex } from "../lib/benchmark/artifacts";
import {
  LONG_CALL_ASR_CALIBRATION_ID,
  createLongCallAsrCalibrationArtifact,
  createLongCallAsrCalibrationPlan,
  scoreLongCallAsrCalibration,
  type FrozenLongCallExperimentPlan,
  type LongCallAsrCalibrationTranscript,
} from "../lib/benchmark/long-call-asr-calibration";
import {
  finalizeWhisperCppAsrToolchain,
  prepareWhisperCppAsrToolchain,
  runPreparedWhisperCppAsr,
  type WhisperCppAsrConfig,
} from "../lib/benchmark/whisper-cpp-asr";

const PLAN_FILE = "experiment-plan.json";
const OUTPUT_DIRECTORY = "asr-calibration-evidence";
const OUTPUT_FILE = "asr-calibration.json";
const PLAN_DOMAIN = "harshas-amazing-call-center/long-call-plan/v1\n";
const RECEIPTS_MANIFEST_DOMAIN = "hacc/long-call-asr-calibration-receipts/v1\n";
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function flag(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}

function absoluteFlag(name: string): string {
  const value = flag(name);
  if (!isAbsolute(value) || resolve(value) !== value) throw new Error(`${name} must be an absolute normalized path`);
  return value;
}

function integerFlag(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function pinnedConfig(): WhisperCppAsrConfig {
  return Object.freeze({
    whisperCliPath: absoluteFlag("--whisper-cli"),
    whisperCliSha256: flag("--whisper-cli-sha256"),
    whisperCppVersion: flag("--whisper-cpp-version"),
    whisperCppSourceRevision: flag("--whisper-cpp-revision"),
    modelPath: absoluteFlag("--model"),
    modelSha256: flag("--model-sha256"),
    modelId: flag("--model-id"),
    modelRevision: flag("--model-revision"),
    ffmpegPath: absoluteFlag("--ffmpeg"),
    ffmpegSha256: flag("--ffmpeg-sha256"),
    language: flag("--language"),
    threads: integerFlag("--threads", 4),
    beamSize: integerFlag("--beam-size", 5),
    bestOf: integerFlag("--best-of", 5),
    timeoutMs: integerFlag("--timeout-ms", 600_000),
  });
}

async function pathMustNotExist(path: string): Promise<void> {
  try {
    await stat(path);
    throw new Error(`immutable calibration output already exists: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function loadFrozenPlan(root: string): Promise<FrozenLongCallExperimentPlan> {
  const raw = JSON.parse(await readFile(resolve(root, PLAN_FILE), "utf8")) as FrozenLongCallExperimentPlan & Record<string, unknown>;
  const { planSha256, ...body } = raw;
  if (sha256Hex(`${PLAN_DOMAIN}${canonicalJson(body)}`) !== planSha256) throw new Error("experiment plan hash mismatch");
  return raw;
}

function safeFixturePath(root: string, relative: string): string {
  if (!SAFE_RELATIVE_PATH.test(relative) || relative.split("/").some((part) => part === "." || part === "..")) {
    throw new Error(`unsafe fixture path: ${relative}`);
  }
  const path = resolve(root, relative);
  if (!path.startsWith(`${root}${sep}`)) throw new Error(`fixture escapes experiment root: ${relative}`);
  return path;
}

function calibrationMarkdown(artifact: Readonly<{
  gatePass: boolean;
  metrics: Readonly<{
    plannedFixtures: number;
    completedFixtures: number;
    fixtureCoverage: number;
    totalReferenceWords: number;
    totalWordErrors: number;
    wordErrorRate: number;
    expectedCriticalSlots: number;
    detectedCriticalSlots: number;
    criticalSlotFalseNegatives: number;
    semanticSlotFalsePositives: number;
  }>;
  thresholds: Readonly<{
    maximumWordErrorRate: number;
    requiredFixtureCoverage: number;
    maximumCriticalSlotFalseNegatives: number;
    maximumSemanticSlotFalsePositives: number;
  }>;
  fixtureManifestSha256: string;
  asrConfigSha256: string;
  receiptsManifestSha256: string;
  artifactSha256: string;
}>): string {
  const percent = (value: number): string => `${(value * 100).toFixed(2)}%`;
  return `# HACC-LC3 caller ASR calibration\n\n` +
    `Gate: **${artifact.gatePass ? "PASS" : "FAIL"}**\n\n` +
    `| Check | Result | Preregistered threshold |\n` +
    `| --- | ---: | ---: |\n` +
    `| Frozen 24 kHz fixture coverage | ${artifact.metrics.completedFixtures}/${artifact.metrics.plannedFixtures} (${percent(artifact.metrics.fixtureCoverage)}) | ${percent(artifact.thresholds.requiredFixtureCoverage)} |\n` +
    `| Micro-averaged word error rate | ${artifact.metrics.totalWordErrors}/${artifact.metrics.totalReferenceWords} (${percent(artifact.metrics.wordErrorRate)}) | <= ${percent(artifact.thresholds.maximumWordErrorRate)} |\n` +
    `| Critical corrected-ID / numeric-limit slots | ${artifact.metrics.detectedCriticalSlots}/${artifact.metrics.expectedCriticalSlots} | 0 false negatives |\n` +
    `| Semantic slot false positives | ${artifact.metrics.semanticSlotFalsePositives} | 0 |\n\n` +
    `Normalization is frozen as Unicode NFKD, lowercase, diacritic removal, ampersand expansion, apostrophe deletion, punctuation removal, spoken-cardinal conversion, decimal digit splitting, and joining consecutive spelled letters. WER is Levenshtein word distance summed over all fixtures divided by the summed normalized reference-word count.\n\n` +
    `Selection is deterministic: caller turns 1, 4, 9, 14, 17, and 20 from each of three task families and each of three macOS TTS voices (54 fixtures total; six per family-by-voice stratum).\n\n` +
    `- Fixture manifest SHA-256: \`${artifact.fixtureManifestSha256}\`\n` +
    `- Prepared ASR config SHA-256: \`${artifact.asrConfigSha256}\`\n` +
    `- Receipt manifest SHA-256: \`${artifact.receiptsManifestSha256}\`\n` +
    `- Calibration artifact SHA-256: \`${artifact.artifactSha256}\`\n`;
}

async function makeReadOnlyRecursively(root: string, receiptPaths: readonly string[]): Promise<void> {
  await Promise.all([
    chmod(resolve(root, "calibration.json"), 0o400),
    chmod(resolve(root, "calibration.md"), 0o400),
    chmod(resolve(root, "receipts-manifest.json"), 0o400),
    ...receiptPaths.map((path) => chmod(path, 0o400)),
  ]);
  await chmod(resolve(root, "receipts"), 0o500);
  await chmod(root, 0o500);
}

async function main(): Promise<void> {
  const root = absoluteFlag("--root");
  const config = pinnedConfig();
  const plan = await loadFrozenPlan(root);
  const calibrationPlan = createLongCallAsrCalibrationPlan(plan);
  const finalDirectory = resolve(root, OUTPUT_DIRECTORY);
  const finalFile = resolve(root, OUTPUT_FILE);
  const stagingDirectory = resolve(root, `.${OUTPUT_DIRECTORY}.partial`);
  await pathMustNotExist(finalDirectory);
  await pathMustNotExist(finalFile);
  await pathMustNotExist(stagingDirectory);
  await mkdir(resolve(stagingDirectory, "receipts"), { recursive: true, mode: 0o700 });

  const toolchain = await prepareWhisperCppAsrToolchain({
    batchId: `${plan.experimentId}-caller-calibration`,
    config,
  });
  const transcripts: LongCallAsrCalibrationTranscript[] = [];
  const receiptEntries: Array<Readonly<{
    calibrationUnitId: string;
    path: string;
    receiptSha256: string;
    transcriptSha256: string;
    fixtureSha256: string;
  }>> = [];
  const receiptPaths: string[] = [];
  let invocationError: unknown;
  let batchFinalization: Awaited<ReturnType<typeof finalizeWhisperCppAsrToolchain>> | undefined;
  try {
    for (const fixture of calibrationPlan.fixtures) {
      const pcm = new Uint8Array(await readFile(safeFixturePath(root, fixture.path)));
      if (pcm.byteLength !== fixture.byteLength || sha256Hex(pcm) !== fixture.sha256) {
        throw new Error(`frozen fixture bytes mismatch: ${fixture.path}`);
      }
      const run = await runPreparedWhisperCppAsr({
        toolchain,
        source: {
          runId: `${plan.experimentId}-caller-calibration`,
          unitId: fixture.calibrationUnitId,
          invocationId: fixture.calibrationUnitId,
          sourceRequestSha256: fixture.sourceTextSha256,
          sourceChunkSequenceSha256: fixture.sha256,
          pcm16Mono24khz: pcm,
        },
      });
      if (run.receipt.toolchain_verification.mode !== "prepared_batch"
        || run.receipt.toolchain_verification.batch_id !== toolchain.batchId
        || run.receipt.input.pcm_sha256 !== fixture.sha256
        || run.receipt.source_played_audio_sha256 !== fixture.sha256) {
        throw new Error(`ASR receipt binding mismatch: ${fixture.calibrationUnitId}`);
      }
      const relativeReceiptPath = `receipts/${String(fixture.ordinal).padStart(2, "0")}-${fixture.calibrationUnitId}.json`;
      const receiptPath = resolve(stagingDirectory, relativeReceiptPath);
      await writeFile(receiptPath, run.canonicalReceiptJson, { flag: "wx", mode: 0o600 });
      receiptPaths.push(receiptPath);
      transcripts.push(Object.freeze({
        calibrationUnitId: fixture.calibrationUnitId,
        transcript: run.receipt.result.transcript,
        receiptSha256: run.receipt.receipt_sha256,
        playedAudioSha256: run.receipt.source_played_audio_sha256,
      }));
      receiptEntries.push(Object.freeze({
        calibrationUnitId: fixture.calibrationUnitId,
        path: relativeReceiptPath,
        receiptSha256: run.receipt.receipt_sha256,
        transcriptSha256: sha256Hex(run.receipt.result.transcript),
        fixtureSha256: fixture.sha256,
      }));
    }
  } catch (error) {
    invocationError = error;
  } finally {
    try {
      batchFinalization = await finalizeWhisperCppAsrToolchain(toolchain);
    } catch (error) {
      invocationError ??= error;
    }
  }
  if (invocationError || !batchFinalization) {
    const failurePath = resolve(stagingDirectory, "failure.json");
    await writeFile(failurePath, `${canonicalJson({
      schemaVersion: 1,
      calibrationId: LONG_CALL_ASR_CALIBRATION_ID,
      experimentPlanSha256: plan.planSha256,
      calibrationPlanSha256: calibrationPlan.calibrationPlanSha256,
      asrConfigSha256: toolchain.configSha256,
      completedInvocations: receiptEntries.length,
      batchFinalization: batchFinalization ?? null,
      error: invocationError instanceof Error ? invocationError.message : "ASR calibration failed",
    })}\n`, { flag: "wx", mode: 0o600 });
    await Promise.all([...receiptPaths.map((path) => chmod(path, 0o400)), chmod(failurePath, 0o400)]);
    await chmod(resolve(stagingDirectory, "receipts"), 0o500);
    await chmod(stagingDirectory, 0o500);
    throw invocationError instanceof Error ? invocationError : new Error("ASR calibration failed");
  }
  if (batchFinalization.invocation_count !== calibrationPlan.plannedFixtureCount) {
    throw new Error("prepared ASR finalization has incomplete invocation coverage");
  }
  const receiptsBody = Object.freeze({
    schemaVersion: 1 as const,
    calibrationId: LONG_CALL_ASR_CALIBRATION_ID,
    experimentId: plan.experimentId,
    experimentPlanSha256: plan.planSha256,
    fixtureManifestSha256: plan.fixtureManifestSha256,
    calibrationPlanSha256: calibrationPlan.calibrationPlanSha256,
    asrConfigSha256: toolchain.configSha256,
    batchFinalization,
    receipts: Object.freeze(receiptEntries),
  });
  const receiptsManifest = Object.freeze({
    ...receiptsBody,
    receiptsManifestSha256: sha256Hex(`${RECEIPTS_MANIFEST_DOMAIN}${canonicalJson(receiptsBody)}`),
  });
  const scored = scoreLongCallAsrCalibration({ plan: calibrationPlan, transcripts });
  const artifact = createLongCallAsrCalibrationArtifact({
    scored,
    fixtureManifestSha256: plan.fixtureManifestSha256,
    asrConfigSha256: toolchain.configSha256,
    asrBatchFinalizationSha256: batchFinalization.finalization_sha256,
    receiptsManifestSha256: receiptsManifest.receiptsManifestSha256,
  });
  await writeFile(resolve(stagingDirectory, "receipts-manifest.json"), `${canonicalJson(receiptsManifest)}\n`, { flag: "wx", mode: 0o600 });
  await writeFile(resolve(stagingDirectory, "calibration.json"), `${canonicalJson(artifact)}\n`, { flag: "wx", mode: 0o600 });
  await writeFile(resolve(stagingDirectory, "calibration.md"), calibrationMarkdown(artifact), { flag: "wx", mode: 0o600 });
  await makeReadOnlyRecursively(stagingDirectory, receiptPaths);
  await rename(stagingDirectory, finalDirectory);
  const temporaryFinalFile = resolve(root, `.${OUTPUT_FILE}.${process.pid}.tmp`);
  await writeFile(temporaryFinalFile, `${canonicalJson(artifact)}\n`, { flag: "wx", mode: 0o400 });
  await rename(temporaryFinalFile, finalFile);
  process.stdout.write(`${canonicalJson({
    calibrationId: LONG_CALL_ASR_CALIBRATION_ID,
    output: finalFile,
    evidenceDirectory: finalDirectory,
    gatePass: artifact.gatePass,
    metrics: artifact.metrics,
    artifactSha256: artifact.artifactSha256,
  })}\n`);
  if (!artifact.gatePass) process.exitCode = 2;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "long-call ASR calibration failed"}\n`);
  process.exitCode = 1;
});
