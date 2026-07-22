#!/usr/bin/env node

import { chmod, lstat, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { canonicalJson, sha256Hex } from "../lib/benchmark/artifacts";
import {
  LONG_CALL_ASR_CALIBRATION_ID,
  LONG_CALL_ASR_OUTPUT_FIXTURES_PER_VOICE,
  createOutputVoiceAsrCalibrationArtifact,
  createOutputVoiceCalibrationManifest,
  longCallOutputVoiceRouteId,
  scoreOutputVoiceAsrCalibration,
  validateOutputVoiceCalibrationFixtures,
  verifyOutputVoiceCalibrationPcm,
  verifyOutputVoiceCaptureVerificationReceipt,
  type LongCallAsrCalibrationTranscript,
  type OutputVoiceAsrCalibrationArtifact,
  type OutputVoiceCalibrationManifest,
  type OutputVoiceCaptureVerificationReceipt,
} from "../lib/benchmark/long-call-asr-calibration";
import {
  finalizeWhisperCppAsrToolchain,
  prepareWhisperCppAsrToolchain,
  runPreparedWhisperCppAsr,
  type PreparedWhisperCppAsrToolchain,
  type WhisperCppAsrBatchFinalization,
  type WhisperCppAsrConfig,
} from "../lib/benchmark/whisper-cpp-asr";

const SAFE_FIXTURE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const RECEIPTS_MANIFEST_DOMAIN = "hacc/output-voice-asr-calibration-receipts/v1\n";
const FAILURE_DOMAIN = "hacc/output-voice-asr-calibration-failure/v1\n";

function flag(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}

function absoluteFlag(name: string): string {
  const value = flag(name);
  if (!isAbsolute(value) || resolve(value) !== value) {
    throw new Error(`${name} must be an absolute normalized path`);
  }
  return value;
}

function sha256Flag(name: string): string {
  const value = flag(name);
  if (!SHA256.test(value)) throw new Error(`${name} must be one lowercase SHA-256`);
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
    whisperCliSha256: sha256Flag("--whisper-cli-sha256"),
    whisperCppVersion: flag("--whisper-cpp-version"),
    whisperCppSourceRevision: flag("--whisper-cpp-revision"),
    modelPath: absoluteFlag("--model"),
    modelSha256: sha256Flag("--model-sha256"),
    modelId: flag("--model-id"),
    modelRevision: flag("--model-revision"),
    ffmpegPath: absoluteFlag("--ffmpeg"),
    ffmpegSha256: sha256Flag("--ffmpeg-sha256"),
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

async function requireRegularDirectory(path: string, label: string): Promise<string> {
  const metadata = await lstat(path).catch(() => null);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular directory, not a symlink`);
  }
  if (await realpath(path) !== path) throw new Error(`${label} must be a canonical real path`);
  return path;
}

async function fixturePath(root: string, path: string): Promise<string> {
  if (!SAFE_FIXTURE_PATH.test(path)
    || !path.startsWith("output-voice-calibration/")
    || path.split("/").some((part) => part === "." || part === "..")) {
    throw new Error(`unsafe output-voice fixture path: ${path}`);
  }
  const resolved = resolve(root, path);
  if (!resolved.startsWith(`${root}${sep}`)) throw new Error(`output-voice fixture escapes root: ${path}`);
  const metadata = await lstat(resolved).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink() || await realpath(resolved) !== resolved) {
    throw new Error(`output-voice fixture must be a regular non-symlink file: ${path}`);
  }
  return resolved;
}

async function lockAndPublishDirectory(input: Readonly<{
  stagingDirectory: string;
  finalDirectory: string;
  filePaths: readonly string[];
}>): Promise<void> {
  await Promise.all(input.filePaths.map((path) => chmod(path, 0o400)));
  await chmod(resolve(input.stagingDirectory, "receipts"), 0o500);
  await chmod(input.stagingDirectory, 0o500);
  await rename(input.stagingDirectory, input.finalDirectory);
}

function calibrationMarkdown(artifact: OutputVoiceAsrCalibrationArtifact): string {
  const percent = (value: number): string => `${(value * 100).toFixed(2)}%`;
  const routeRows = artifact.outputVoiceMetrics.map((route) =>
    `| ${route.routeId} | ${route.completedFixtures}/${route.plannedFixtures} | ${percent(route.wordErrorRate)} | ${route.criticalSlotFalseNegatives} | ${route.semanticSlotFalsePositives} |`
  ).join("\n");
  return `# HACC output-voice ASR calibration\n\n`
    + `Gate: **${artifact.gatePass ? "PASS" : "FAIL"}**\n\n`
    + `| Route | Complete | WER | Slot FN | Slot FP |\n`
    + `| --- | ---: | ---: | ---: | ---: |\n`
    + `${routeRows}\n\n`
    + `The gate requires all ${artifact.metrics.plannedFixtures} signed PCM fixtures, WER <= ${percent(artifact.thresholds.maximumWordErrorRate)}, zero critical-slot false negatives, and zero semantic-slot false positives globally and independently for every exact provider/model/voice route.\n\n`
    + `- Capture manifest: \`${artifact.outputVoiceCalibrationManifestSha256}\`\n`
    + `- Capture verification: \`${artifact.captureVerificationSha256}\`\n`
    + `- Capture authority: \`${artifact.captureAuthoritySha256}\`\n`
    + `- Prepared ASR config: \`${artifact.asrConfigSha256}\`\n`
    + `- Prepared batch finalization: \`${artifact.asrBatchFinalizationSha256}\`\n`
    + `- Receipt manifest: \`${artifact.receiptsManifestSha256}\`\n`
    + `- Artifact: \`${artifact.artifactSha256}\`\n`;
}

async function retainFailure(input: Readonly<{
  stagingDirectory: string;
  finalDirectory: string;
  manifest: OutputVoiceCalibrationManifest;
  captureVerification: OutputVoiceCaptureVerificationReceipt;
  captureAuthoritySha256: string;
  toolchain: PreparedWhisperCppAsrToolchain | undefined;
  batchFinalization: WhisperCppAsrBatchFinalization | undefined;
  completedInvocations: number;
  receiptPaths: readonly string[];
  error: unknown;
}>): Promise<void> {
  const body = Object.freeze({
    schemaVersion: 1 as const,
    failureType: "hacc_output_voice_asr_calibration_failure" as const,
    calibrationId: LONG_CALL_ASR_CALIBRATION_ID,
    outputVoiceCalibrationManifestSha256: input.manifest.manifestSha256,
    captureVerificationSha256: input.captureVerification.verificationSha256,
    captureAuthoritySha256: input.captureAuthoritySha256,
    asrConfigSha256: input.toolchain?.configSha256 ?? null,
    completedInvocations: input.completedInvocations,
    plannedInvocations: input.manifest.fixtures.length,
    batchFinalization: input.batchFinalization ?? null,
    error: input.error instanceof Error ? input.error.message : "output-voice ASR calibration failed",
  });
  const failure = Object.freeze({
    ...body,
    failureSha256: sha256Hex(`${FAILURE_DOMAIN}${canonicalJson(body)}`),
  });
  const failurePath = resolve(input.stagingDirectory, "failure.json");
  await writeFile(failurePath, `${canonicalJson(failure)}\n`, { flag: "wx", mode: 0o600 });
  await lockAndPublishDirectory({
    stagingDirectory: input.stagingDirectory,
    finalDirectory: input.finalDirectory,
    filePaths: [...input.receiptPaths, failurePath],
  });
}

async function main(): Promise<void> {
  const manifestPath = absoluteFlag("--manifest");
  const root = await requireRegularDirectory(absoluteFlag("--root"), "--root");
  const captureVerificationPath = absoluteFlag("--capture-verification");
  const expectedCaptureAuthoritySha256 = sha256Flag("--expected-capture-authority-sha256");
  const finalDirectory = absoluteFlag("--output");
  if (finalDirectory === sep) throw new Error("--output may not be the filesystem root");
  const stagingDirectory = resolve(dirname(finalDirectory), `.${basename(finalDirectory)}.partial`);
  const config = pinnedConfig();

  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as OutputVoiceCalibrationManifest;
  const canonicalManifest = createOutputVoiceCalibrationManifest(manifest.fixtures);
  if (canonicalJson(canonicalManifest) !== canonicalJson(manifest)) {
    throw new Error("output-voice calibration manifest is noncanonical or has a version/hash mismatch");
  }
  const fixtures = validateOutputVoiceCalibrationFixtures({
    fixtures: manifest.fixtures,
    manifestSha256: manifest.manifestSha256,
  });
  if (fixtures.length !== manifest.requiredOutputVoiceRoutes.length * LONG_CALL_ASR_OUTPUT_FIXTURES_PER_VOICE) {
    throw new Error("output-voice calibration fixture inventory is incomplete");
  }
  const captureVerification = JSON.parse(
    await readFile(captureVerificationPath, "utf8")
  ) as OutputVoiceCaptureVerificationReceipt;
  verifyOutputVoiceCaptureVerificationReceipt({
    receipt: captureVerification,
    manifest,
    expectedCaptureAuthoritySha256,
  });

  // Fail closed before toolchain preparation: every signed PCM/chunk binding
  // is validated and the exact verified bytes are retained for transcription.
  const verifiedPcm = new Map<string, Uint8Array>();
  for (const fixture of fixtures) {
    const pcm = new Uint8Array(await readFile(await fixturePath(root, fixture.path)));
    verifyOutputVoiceCalibrationPcm({ fixture, pcm, expectedCaptureAuthoritySha256 });
    verifiedPcm.set(fixture.calibrationUnitId, pcm);
  }
  if (verifiedPcm.size !== fixtures.length) throw new Error("verified PCM inventory is incomplete");

  await mkdir(dirname(finalDirectory), { recursive: true, mode: 0o700 });
  await pathMustNotExist(finalDirectory);
  await pathMustNotExist(stagingDirectory);
  await mkdir(resolve(stagingDirectory, "receipts"), { recursive: true, mode: 0o700 });

  let toolchain: PreparedWhisperCppAsrToolchain | undefined;
  let batchFinalization: WhisperCppAsrBatchFinalization | undefined;
  let invocationError: unknown;
  const transcripts: LongCallAsrCalibrationTranscript[] = [];
  const receiptPaths: string[] = [];
  const receiptEntries: Array<Readonly<{
    ordinal: number;
    calibrationUnitId: string;
    provider: string;
    model: string;
    voice: string;
    routeId: string;
    path: string;
    fixtureSha256: string;
    captureReceiptSha256: string;
    asrReceiptSha256: string;
    transcriptSha256: string;
  }>> = [];
  try {
    toolchain = await prepareWhisperCppAsrToolchain({
      batchId: `output-asr-${manifest.manifestSha256.slice(0, 32)}`,
      config,
    });
    for (const [index, fixture] of fixtures.entries()) {
      const pcm = verifiedPcm.get(fixture.calibrationUnitId);
      if (!pcm) throw new Error(`verified PCM is missing: ${fixture.calibrationUnitId}`);
      const run = await runPreparedWhisperCppAsr({
        toolchain,
        source: {
          runId: `output-asr-${manifest.manifestSha256.slice(0, 32)}`,
          unitId: fixture.calibrationUnitId,
          invocationId: fixture.calibrationUnitId,
          sourceRequestSha256: fixture.referenceTextSha256,
          sourceChunkSequenceSha256: fixture.sha256,
          pcm16Mono24khz: pcm,
        },
      });
      if (run.receipt.toolchain_verification.mode !== "prepared_batch"
        || run.receipt.toolchain_verification.batch_id !== toolchain.batchId
        || run.receipt.config_sha256 !== toolchain.configSha256
        || run.receipt.input.pcm_sha256 !== fixture.sha256
        || run.receipt.source_played_audio_sha256 !== fixture.sha256
        || run.receipt.source_request_sha256 !== fixture.referenceTextSha256
        || run.receipt.source_chunk_sequence_sha256 !== fixture.sha256) {
        throw new Error(`output-voice ASR receipt binding mismatch: ${fixture.calibrationUnitId}`);
      }
      const relativeReceiptPath = `receipts/${String(index + 1).padStart(2, "0")}-${fixture.calibrationUnitId}.json`;
      const receiptPath = resolve(stagingDirectory, relativeReceiptPath);
      await writeFile(receiptPath, `${run.canonicalReceiptJson.trimEnd()}\n`, { flag: "wx", mode: 0o600 });
      receiptPaths.push(receiptPath);
      transcripts.push(Object.freeze({
        calibrationUnitId: fixture.calibrationUnitId,
        transcript: run.receipt.result.transcript,
        receiptSha256: run.receipt.receipt_sha256,
        playedAudioSha256: run.receipt.source_played_audio_sha256,
      }));
      receiptEntries.push(Object.freeze({
        ordinal: index + 1,
        calibrationUnitId: fixture.calibrationUnitId,
        provider: fixture.provider,
        model: fixture.model,
        voice: fixture.voice,
        routeId: longCallOutputVoiceRouteId(fixture),
        path: relativeReceiptPath,
        fixtureSha256: fixture.sha256,
        captureReceiptSha256: fixture.captureReceipt.receiptSha256,
        asrReceiptSha256: run.receipt.receipt_sha256,
        transcriptSha256: sha256Hex(run.receipt.result.transcript),
      }));
    }
  } catch (error) {
    invocationError = error;
  } finally {
    if (toolchain) {
      try {
        batchFinalization = await finalizeWhisperCppAsrToolchain(toolchain);
      } catch (error) {
        invocationError ??= error;
      }
    }
  }
  if (!invocationError && (!toolchain
    || !batchFinalization
    || batchFinalization.invocation_count !== fixtures.length
    || batchFinalization.invocation_receipts.length !== fixtures.length)) {
    invocationError = new Error("prepared ASR finalization has incomplete 18-fixture invocation coverage");
  }
  if (invocationError || !toolchain || !batchFinalization) {
    await retainFailure({
      stagingDirectory,
      finalDirectory,
      manifest,
      captureVerification,
      captureAuthoritySha256: expectedCaptureAuthoritySha256,
      toolchain,
      batchFinalization,
      completedInvocations: receiptEntries.length,
      receiptPaths,
      error: invocationError,
    });
    throw invocationError instanceof Error ? invocationError : new Error("output-voice ASR calibration failed");
  }

  const receiptsBody = Object.freeze({
    schemaVersion: 1 as const,
    manifestSha256: manifest.manifestSha256,
    captureVerificationSha256: captureVerification.verificationSha256,
    captureAuthoritySha256: expectedCaptureAuthoritySha256,
    asrConfigSha256: toolchain.configSha256,
    batchFinalization,
    receipts: Object.freeze(receiptEntries),
  });
  const receiptsManifest = Object.freeze({
    ...receiptsBody,
    receiptsManifestSha256: sha256Hex(`${RECEIPTS_MANIFEST_DOMAIN}${canonicalJson(receiptsBody)}`),
  });
  const scored = scoreOutputVoiceAsrCalibration({ manifest, transcripts });
  const artifact = createOutputVoiceAsrCalibrationArtifact({
    scored,
    captureVerificationSha256: captureVerification.verificationSha256,
    captureAuthoritySha256: expectedCaptureAuthoritySha256,
    asrConfigSha256: toolchain.configSha256,
    asrBatchFinalizationSha256: batchFinalization.finalization_sha256,
    receiptsManifestSha256: receiptsManifest.receiptsManifestSha256,
  });
  const receiptsManifestPath = resolve(stagingDirectory, "receipts-manifest.json");
  const calibrationPath = resolve(stagingDirectory, "calibration.json");
  const markdownPath = resolve(stagingDirectory, "calibration.md");
  await writeFile(receiptsManifestPath, `${canonicalJson(receiptsManifest)}\n`, { flag: "wx", mode: 0o600 });
  await writeFile(calibrationPath, `${canonicalJson(artifact)}\n`, { flag: "wx", mode: 0o600 });
  await writeFile(markdownPath, calibrationMarkdown(artifact), { flag: "wx", mode: 0o600 });
  await lockAndPublishDirectory({
    stagingDirectory,
    finalDirectory,
    filePaths: [...receiptPaths, receiptsManifestPath, calibrationPath, markdownPath],
  });
  process.stdout.write(`${canonicalJson({
    output: finalDirectory,
    gatePass: artifact.gatePass,
    manifestSha256: manifest.manifestSha256,
    captureVerificationSha256: captureVerification.verificationSha256,
    asrConfigSha256: toolchain.configSha256,
    completedFixtures: artifact.metrics.completedFixtures,
    artifactSha256: artifact.artifactSha256,
  })}\n`);
  if (!artifact.gatePass) process.exitCode = 2;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "output-voice ASR calibration failed"}\n`);
  process.exitCode = 1;
});
