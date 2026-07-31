import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { runWhisperCppAsr } from "../lib/benchmark/whisper-cpp-asr";

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

async function main(): Promise<void> {
  const pcmPath = absoluteFlag("--pcm");
  const outputPath = absoluteFlag("--output");
  const pcm = await readFile(pcmPath);
  const run = await runWhisperCppAsr({
    config: {
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
    },
    source: {
      runId: flag("--run-id"),
      unitId: flag("--unit-id"),
      invocationId: flag("--invocation-id"),
      sourceRequestSha256: flag("--source-request-sha256"),
      sourceChunkSequenceSha256: flag("--source-chunk-sequence-sha256"),
      pcm16Mono24khz: pcm,
    },
  });
  await writeFile(outputPath, run.canonicalReceiptJson, { flag: "wx", mode: 0o600 });
  process.stdout.write(`${run.receipt.receipt_sha256}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "long-call ASR failed"}\n`);
  process.exitCode = 1;
});
