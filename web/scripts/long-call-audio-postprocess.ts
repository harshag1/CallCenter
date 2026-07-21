#!/usr/bin/env node

import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { canonicalJson, sha256Hex } from "../lib/benchmark/artifacts";
import {
  longCallAsrToolchainConfigSha256,
  postprocessLongCallAudioRun,
} from "../lib/benchmark/long-call-audio-semantics";
import {
  finalizeWhisperCppAsrToolchain,
  prepareWhisperCppAsrToolchain,
  runPreparedWhisperCppAsr,
  type WhisperCppAsrConfig,
} from "../lib/benchmark/whisper-cpp-asr";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
  return value;
}

function required(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function absolute(name: string): string {
  const value = required(name);
  if (!isAbsolute(value) || resolve(value) !== value) throw new Error(`--${name} must be an absolute normalized path`);
  return value;
}

function integer(name: string, fallback: number, maximum: number): number {
  const raw = option(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`--${name} must be an integer from 1 through ${maximum}`);
  }
  return value;
}

function config(): WhisperCppAsrConfig {
  return Object.freeze({
    whisperCliPath: absolute("whisper-cli"),
    whisperCliSha256: required("whisper-cli-sha256"),
    whisperCppVersion: required("whisper-cpp-version"),
    whisperCppSourceRevision: required("whisper-cpp-revision"),
    modelPath: absolute("model"),
    modelSha256: required("model-sha256"),
    modelId: required("model-id"),
    modelRevision: required("model-revision"),
    ffmpegPath: absolute("ffmpeg"),
    ffmpegSha256: required("ffmpeg-sha256"),
    language: option("language") ?? "en",
    threads: integer("threads", 4, 256),
    beamSize: integer("beam-size", 5, 64),
    bestOf: integer("best-of", 5, 64),
    timeoutMs: integer("timeout-ms", 600_000, 3_600_000),
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function selectedRunDirectories(root: string): Promise<readonly string[]> {
  const runsRoot = resolve(root, "runs");
  const selectedRunId = option("run-id");
  const names = (await readdir(runsRoot))
    .filter((entry) => entry.endsWith(".complete"))
    .filter((entry) => !selectedRunId || entry === `${selectedRunId}.complete`)
    .sort();
  if (names.length === 0) throw new Error(selectedRunId ? `completed run not found: ${selectedRunId}` : "no completed runs found");
  return Object.freeze(names.map((entry) => resolve(runsRoot, entry)));
}

async function main(): Promise<void> {
  if (process.argv[2] !== "run") {
    throw new Error("usage: long-call-audio-postprocess run --root ABSOLUTE_DIR [pinned ASR options]");
  }
  const root = absolute("root");
  const asrConfig = config();
  const runs = await selectedRunDirectories(root);
  const completed = [] as string[];
  const pending = [] as string[];
  for (const run of runs) {
    (await exists(resolve(run, "asr")) ? completed : pending).push(run);
  }

  // Re-verify exact manifests and repair summary projection only from those
  // immutable manifests. The transcriber is unreachable on this path.
  for (const runDirectory of completed) {
    await postprocessLongCallAudioRun({
      runDirectory,
      config: asrConfig,
      asrRunner: async () => { throw new Error("existing ASR manifests may not invoke transcription"); },
    });
  }

  if (pending.length === 0) {
    process.stdout.write(`${canonicalJson({
      action: "audio-postprocess-verified",
      selectedRuns: runs.length,
      newlyProcessedRuns: 0,
      toolchainConfigSha256: longCallAsrToolchainConfigSha256(asrConfig),
    })}\n`);
    return;
  }
  const selectionSha256 = sha256Hex(canonicalJson(pending.map((run) => basename(run, ".complete"))));
  const batchId = `${basename(root)}-post-${selectionSha256.slice(0, 16)}`;
  const finalizationsDirectory = resolve(root, "asr-batch-finalizations");
  const finalizationPath = resolve(finalizationsDirectory, `${batchId}.json`);
  try {
    await stat(finalizationPath);
    throw new Error("this exact ASR run selection is already finalized while selected runs remain unprocessed");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(finalizationsDirectory, { recursive: true, mode: 0o700 });
  const toolchain = await prepareWhisperCppAsrToolchain({ batchId, config: asrConfig });
  if (toolchain.configSha256 !== longCallAsrToolchainConfigSha256(asrConfig)) {
    throw new Error("prepared ASR toolchain config identity differs from the calibration identity");
  }
  const concurrency = integer("concurrency", 3, 8);
  const failures: Readonly<{ run: string; message: string }>[] = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
    while (true) {
      const runDirectory = pending[cursor++];
      if (!runDirectory) return;
      try {
        await postprocessLongCallAudioRun({
          runDirectory,
          config: asrConfig,
          asrRunner: ({ source, temporaryRoot }) => runPreparedWhisperCppAsr({
            toolchain,
            source,
            temporaryRoot,
          }),
        });
      } catch (error) {
        failures.push(Object.freeze({
          run: basename(runDirectory, ".complete"),
          message: error instanceof Error ? error.message : "unknown ASR failure",
        }));
      }
    }
  }));
  const finalization = await finalizeWhisperCppAsrToolchain(toolchain);
  await writeFile(finalizationPath, `${canonicalJson(finalization)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  if (failures.length) {
    throw new Error(`ASR batch retained ${failures.length} failed run(s): ${canonicalJson(failures)}`);
  }
  process.stdout.write(`${canonicalJson({
    action: "audio-postprocess-completed",
    selectedRuns: runs.length,
    newlyProcessedRuns: pending.length,
    asrInvocations: finalization.invocation_count,
    toolchainConfigSha256: finalization.config_sha256,
    batchFinalizationSha256: finalization.finalization_sha256,
  })}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${canonicalJson({
    errorClass: error instanceof Error ? error.name : "NonErrorThrow",
    message: error instanceof Error ? error.message : "long-call audio postprocessing failed",
  })}\n`);
  process.exitCode = 1;
});
