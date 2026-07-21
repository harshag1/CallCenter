import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJson, sha256Hex } from "./artifacts";

const SHA256 = /^[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40,64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_PCM_BYTES = 256 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024;
const CONFIG_DOMAIN = "hacc/whisper-cpp-asr-config/v1\n";
const ARGV_DOMAIN = "hacc/local-process-argv/v1\n";
const RESULT_DOMAIN = "hacc/whisper-cpp-asr-result/v1\n";
const RECEIPT_DOMAIN = "hacc/whisper-cpp-asr-receipt/v1\n";
const BATCH_FINALIZATION_DOMAIN = "hacc/whisper-cpp-asr-batch-finalization/v1\n";
const BATCH_INVENTORY_DOMAIN = "hacc/whisper-cpp-asr-batch-inventory/v1\n";
const RESAMPLING_PROFILE = "ffmpeg-pcm16le-24khz-mono-to-wav-pcm16le-16khz-mono-bitexact-v1";

export type LocalAsrProcessRequest = Readonly<{
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
}>;

export type LocalAsrProcessResult = Readonly<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  runtimeMs: number;
}>;

export type LocalAsrProcessRunner = (
  request: LocalAsrProcessRequest
) => Promise<LocalAsrProcessResult>;

export type WhisperCppAsrConfig = Readonly<{
  whisperCliPath: string;
  whisperCliSha256: string;
  whisperCppVersion: string;
  whisperCppSourceRevision: string;
  modelPath: string;
  modelSha256: string;
  modelId: string;
  modelRevision: string;
  ffmpegPath: string;
  ffmpegSha256: string;
  language: string;
  threads: number;
  beamSize: number;
  bestOf: number;
  timeoutMs: number;
}>;

export type WhisperCppAsrSource = Readonly<{
  runId: string;
  unitId: string;
  invocationId: string;
  sourceRequestSha256: string;
  sourceChunkSequenceSha256: string;
  pcm16Mono24khz: Uint8Array;
}>;

export type WhisperCppAsrNormalizedResult = Readonly<{
  status: "completed";
  source_request_sha256: string;
  source_played_audio_sha256: string;
  source_chunk_sequence_sha256: string;
  language: string;
  transcript: string;
  processed_through_sample: number;
  no_speech_probability_ppm: null;
  spans: readonly Readonly<{
    span_id: "span-000";
    text: string;
    utf8_start: 0;
    utf8_end: number;
    audio_start_sample: 0;
    audio_end_sample: number;
    confidence_ppm: null;
  }>[];
}>;

export type WhisperCppAsrReceipt = Readonly<{
  schema_version: 1;
  receipt_type: "hacc_whisper_cpp_asr";
  invocation_id: string;
  run_id: string;
  unit_id: string;
  source_request_sha256: string;
  source_played_audio_sha256: string;
  source_chunk_sequence_sha256: string;
  config_sha256: string;
  toolchain_verification: Readonly<{
    mode: "per_invocation_full_hash";
    batch_id: null;
  }> | Readonly<{
    mode: "prepared_batch";
    batch_id: string;
  }>;
  input: Readonly<{
    encoding: "pcm16";
    endianness: "little";
    sample_rate_hz: 24_000;
    channels: 1;
    byte_length: number;
    sample_count: number;
    pcm_sha256: string;
  }>;
  toolchain: Readonly<{
    whisper_cpp_source_revision: string;
    whisper_cpp_version: string;
    whisper_cli_path_sha256: string;
    whisper_cli_sha256: string;
    model_id: string;
    model_revision: string;
    model_path_sha256: string;
    model_sha256: string;
    ffmpeg_path_sha256: string;
    ffmpeg_sha256: string;
  }>;
  conversion: Readonly<{
    profile: typeof RESAMPLING_PROFILE;
    argv_sha256: string;
    wav_sha256: string;
    wav_byte_length: number;
    runtime_ms: number;
  }>;
  inference: Readonly<{
    argv_sha256: string;
    runtime_ms: number;
    stdout_sha256: string;
    stderr_sha256: string;
    exit_code: 0;
  }>;
  transcript_file_sha256: string;
  normalized_result_sha256: string;
  result: WhisperCppAsrNormalizedResult;
  receipt_sha256: string;
}>;

export type WhisperCppAsrRun = Readonly<{
  receipt: WhisperCppAsrReceipt;
  canonicalReceiptJson: string;
}>;

const PREPARED_TOOLCHAIN = Symbol("prepared-whisper-cpp-asr-toolchain");
export type PreparedWhisperCppAsrToolchain = Readonly<{
  [PREPARED_TOOLCHAIN]: true;
  batchId: string;
  configSha256: string;
}>;

export type WhisperCppAsrBatchFinalization = Readonly<{
  schema_version: 1;
  receipt_type: "hacc_whisper_cpp_asr_batch_finalization";
  batch_id: string;
  config_sha256: string;
  invocation_count: number;
  invocation_receipts: readonly Readonly<{
    invocation_id: string;
    receipt_sha256: string;
  }>[];
  invocation_inventory_sha256: string;
  toolchain: Readonly<{
    whisper_cli_sha256: string;
    model_sha256: string;
    ffmpeg_sha256: string;
  }>;
  finalization_sha256: string;
}>;

function safeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} is not SHA-256`);
  return value;
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value as number;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk: string | Buffer) => {
      hash.update(chunk);
    });
    stream.once("error", rejectPromise);
    stream.once("end", resolvePromise);
  });
  return hash.digest("hex");
}

type PinnedFile = Readonly<{
  path: string;
  sha256: string;
  size: number;
  device: number;
  inode: number;
  modifiedMs: number;
}>;

async function verifyPinnedFile(
  pathInput: string,
  expectedSha256: string,
  label: string,
  executable: boolean
): Promise<PinnedFile> {
  if (typeof pathInput !== "string" || !isAbsolute(pathInput) || resolve(pathInput) !== pathInput) {
    throw new Error(`${label} path must be explicit, absolute, and normalized`);
  }
  const expected = sha(expectedSha256, `${label} expected hash`);
  const metadata = await lstat(pathInput).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} is missing or not a regular file`);
  if (await realpath(pathInput) !== pathInput) throw new Error(`${label} path may not traverse symlinks`);
  await access(pathInput, executable ? constants.R_OK | constants.X_OK : constants.R_OK);
  const actual = await hashFile(pathInput);
  if (actual !== expected) throw new Error(`${label} hash does not match its pin`);
  return Object.freeze({
    path: pathInput,
    sha256: actual,
    size: metadata.size,
    device: metadata.dev,
    inode: metadata.ino,
    modifiedMs: metadata.mtimeMs,
  });
}

async function verifyPinnedFileUnchanged(file: PinnedFile, label: string): Promise<void> {
  const metadata = await lstat(file.path).catch(() => null);
  if (!metadata?.isFile()
    || metadata.isSymbolicLink()
    || metadata.size !== file.size
    || metadata.dev !== file.device
    || metadata.ino !== file.inode
    || metadata.mtimeMs !== file.modifiedMs
    || await hashFile(file.path) !== file.sha256) {
    throw new Error(`${label} changed during ASR execution`);
  }
}

async function verifyPinnedFileMetadataUnchanged(file: PinnedFile, label: string): Promise<void> {
  const metadata = await lstat(file.path).catch(() => null);
  if (!metadata?.isFile()
    || metadata.isSymbolicLink()
    || metadata.size !== file.size
    || metadata.dev !== file.device
    || metadata.ino !== file.inode
    || metadata.mtimeMs !== file.modifiedMs) {
    throw new Error(`${label} identity changed during prepared ASR batch`);
  }
}

function appendCaptured(
  chunks: Buffer[],
  chunk: Buffer,
  state: { bytes: number },
  child: ChildProcessWithoutNullStreams,
  rejectPromise: (error: Error) => void
): void {
  state.bytes += chunk.byteLength;
  if (state.bytes > MAX_PROCESS_OUTPUT_BYTES) {
    child.kill("SIGKILL");
    rejectPromise(new Error("local ASR process output exceeded 2 MiB"));
    return;
  }
  chunks.push(chunk);
}

export const runLocalAsrProcess: LocalAsrProcessRunner = async (request) => {
  return new Promise<LocalAsrProcessResult>((resolvePromise, rejectPromise) => {
    const started = performance.now();
    const child: ChildProcessWithoutNullStreams = spawn(request.executable, [...request.args], {
      cwd: request.cwd,
      shell: false,
      windowsHide: true,
      stdio: "pipe",
      env: Object.freeze({
        NODE_ENV: process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test"
          ? process.env.NODE_ENV
          : "production",
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        LC_ALL: "C",
        LANG: "C",
        TZ: "UTC",
      }) as NodeJS.ProcessEnv,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const stdoutState = { bytes: 0 };
    const stderrState = { bytes: 0 };
    let settled = false;
    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      rejectPromise(error);
    };
    const timer = setTimeout(() => rejectOnce(new Error("local ASR process timed out")), request.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => appendCaptured(stdout, chunk, stdoutState, child, rejectOnce));
    child.stderr.on("data", (chunk: Buffer) => appendCaptured(stderr, chunk, stderrState, child, rejectOnce));
    child.once("error", () => rejectOnce(new Error("local ASR process failed to start")));
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(Object.freeze({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        runtimeMs: Math.max(0, Math.round(performance.now() - started)),
      }));
    });
    child.stdin.end();
  });
};

async function runChecked(
  runner: LocalAsrProcessRunner,
  request: LocalAsrProcessRequest,
  label: string
): Promise<LocalAsrProcessResult> {
  let result: LocalAsrProcessResult;
  try {
    result = await runner(request);
  } catch (error) {
    if (error instanceof Error && error.message === "local ASR process timed out") {
      throw new Error(`${label} timed out`);
    }
    throw new Error(`${label} could not be executed`);
  }
  if (result.exitCode !== 0) throw new Error(`${label} exited unsuccessfully`);
  if (!Number.isSafeInteger(result.runtimeMs) || result.runtimeMs < 0) {
    throw new Error(`${label} returned invalid runtime evidence`);
  }
  return result;
}

function decodingConfig(config: WhisperCppAsrConfig) {
  if (typeof config.language !== "string" || !/^[a-z]{2,3}$/.test(config.language)) {
    throw new Error("ASR language is invalid");
  }
  return Object.freeze({
    language: config.language,
    task: "transcribe" as const,
    temperature_milli: 0 as const,
    beam_size: positiveInteger(config.beamSize, "ASR beam size", 64),
    best_of: positiveInteger(config.bestOf, "ASR best-of", 64),
    threads: positiveInteger(config.threads, "ASR thread count", 256),
    condition_on_previous_text: false as const,
  });
}

type VerifiedWhisperCppToolchain = Readonly<{
  config: WhisperCppAsrConfig;
  whisperCli: PinnedFile;
  model: PinnedFile;
  ffmpeg: PinnedFile;
  whisperCppVersion: string;
  modelId: string;
  timeoutMs: number;
  decoding: ReturnType<typeof decodingConfig>;
  configSha256: string;
}>;

type PreparedToolchainState = {
  status: "active" | "finalizing" | "finalized";
  activeRuns: number;
  batchId: string;
  toolchain: VerifiedWhisperCppToolchain;
  reservedInvocationIds: Set<string>;
  invocationReceipts: Map<string, string>;
};

const preparedToolchainStates = new WeakMap<object, PreparedToolchainState>();

async function verifyWhisperCppToolchain(configInput: WhisperCppAsrConfig): Promise<VerifiedWhisperCppToolchain> {
  const config = Object.freeze({ ...configInput });
  const whisperCli = await verifyPinnedFile(config.whisperCliPath, config.whisperCliSha256, "whisper.cpp CLI", true);
  const model = await verifyPinnedFile(config.modelPath, config.modelSha256, "whisper.cpp model", false);
  const ffmpeg = await verifyPinnedFile(config.ffmpegPath, config.ffmpegSha256, "ffmpeg", true);
  if (!REVISION.test(config.whisperCppSourceRevision)) throw new Error("whisper.cpp source revision is invalid");
  if (!REVISION.test(config.modelRevision)) throw new Error("whisper.cpp model revision is invalid");
  const whisperCppVersion = safeId(config.whisperCppVersion, "whisper.cpp version");
  const modelId = safeId(config.modelId, "whisper.cpp model ID");
  const timeoutMs = positiveInteger(config.timeoutMs, "ASR timeout", 3_600_000);
  const decoding = decodingConfig(config);
  const configSha256 = sha256Hex(`${CONFIG_DOMAIN}${canonicalJson({
    schema_version: 1,
    engine: {
      implementation: "whisper.cpp",
      version: whisperCppVersion,
      source_revision: config.whisperCppSourceRevision,
      executable_sha256: whisperCli.sha256,
      model_id: modelId,
      model_revision: config.modelRevision,
      weights_sha256: model.sha256,
    },
    decoding,
    ffmpeg_sha256: ffmpeg.sha256,
    resampling_profile: RESAMPLING_PROFILE,
    timeout_ms: timeoutMs,
  })}`);
  return Object.freeze({
    config,
    whisperCli,
    model,
    ffmpeg,
    whisperCppVersion,
    modelId,
    timeoutMs,
    decoding,
    configSha256,
  });
}

async function verifyPreparedMetadata(toolchain: VerifiedWhisperCppToolchain): Promise<void> {
  await Promise.all([
    verifyPinnedFileMetadataUnchanged(toolchain.whisperCli, "whisper.cpp CLI"),
    verifyPinnedFileMetadataUnchanged(toolchain.model, "whisper.cpp model"),
    verifyPinnedFileMetadataUnchanged(toolchain.ffmpeg, "ffmpeg"),
  ]);
}

/** Hash and pin a local ASR toolchain once for a many-invocation benchmark batch. */
export async function prepareWhisperCppAsrToolchain(input: Readonly<{
  batchId: string;
  config: WhisperCppAsrConfig;
}>): Promise<PreparedWhisperCppAsrToolchain> {
  const batchId = safeId(input.batchId, "ASR batch ID");
  const toolchain = await verifyWhisperCppToolchain(input.config);
  const handle = Object.freeze({
    [PREPARED_TOOLCHAIN]: true as const,
    batchId,
    configSha256: toolchain.configSha256,
  });
  preparedToolchainStates.set(handle, {
    status: "active",
    activeRuns: 0,
    batchId,
    toolchain,
    reservedInvocationIds: new Set<string>(),
    invocationReceipts: new Map<string, string>(),
  });
  return handle;
}

function normalizeTranscript(bytes: Buffer): string {
  if (bytes.byteLength > MAX_TRANSCRIPT_BYTES) throw new Error("ASR transcript exceeds 1 MiB");
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("ASR transcript is not valid UTF-8");
  }
  if (decoded.includes("\0")) throw new Error("ASR transcript contains a NUL byte");
  return decoded.normalize("NFC").replace(/\r\n?/gu, "\n").replace(/\s+/gu, " ").trim();
}

function stdoutHash(result: LocalAsrProcessResult): string {
  return sha256Hex(Buffer.from(result.stdout, "utf8"));
}

function stderrHash(result: LocalAsrProcessResult): string {
  return sha256Hex(Buffer.from(result.stderr, "utf8"));
}

/**
 * Run a fully local, pinned whisper.cpp transcription over exact PCM evidence.
 * No executable discovery, network request, provider API, or model download is
 * performed. Every artifact needed for replay is hash-bound into the receipt.
 */
async function executeWhisperCppAsr(input: Readonly<{
  config: WhisperCppAsrConfig;
  source: WhisperCppAsrSource;
  processRunner?: LocalAsrProcessRunner;
  temporaryRoot?: string;
}>, prepared?: Readonly<{
  batchId: string;
  toolchain: VerifiedWhisperCppToolchain;
}>): Promise<WhisperCppAsrRun> {
  const source = input.source;
  const runId = safeId(source.runId, "ASR run ID");
  const unitId = safeId(source.unitId, "ASR unit ID");
  const invocationId = safeId(source.invocationId, "ASR invocation ID");
  const sourceRequestSha256 = sha(source.sourceRequestSha256, "ASR source request hash");
  const sourceChunkSequenceSha256 = sha(source.sourceChunkSequenceSha256, "ASR source chunk-sequence hash");
  if (!(source.pcm16Mono24khz instanceof Uint8Array)
    || source.pcm16Mono24khz.byteLength < 2
    || source.pcm16Mono24khz.byteLength > MAX_PCM_BYTES
    || source.pcm16Mono24khz.byteLength % 2 !== 0) {
    throw new Error("ASR input must be non-empty, even-length PCM16 audio within 256 MiB");
  }

  const verifiedToolchain = prepared?.toolchain ?? await verifyWhisperCppToolchain(input.config);
  if (prepared) await verifyPreparedMetadata(verifiedToolchain);
  const {
    config,
    whisperCli,
    model,
    ffmpeg,
    whisperCppVersion,
    modelId,
    timeoutMs,
    decoding,
    configSha256,
  } = verifiedToolchain;
  const sourcePcm = Buffer.from(source.pcm16Mono24khz);
  const sourcePlayedAudioSha256 = sha256Hex(sourcePcm);

  const root = input.temporaryRoot === undefined
    ? tmpdir()
    : input.temporaryRoot;
  if (!isAbsolute(root) || resolve(root) !== root) throw new Error("ASR temporary root must be absolute and normalized");
  const workspace = await mkdtemp(join(root, "hacc-whisper-asr-"));
  const pcmPath = join(workspace, "played.pcm");
  const wavPath = join(workspace, "played-16khz.wav");
  const transcriptPrefix = join(workspace, "transcript");
  const transcriptPath = `${transcriptPrefix}.txt`;
  const processRunner = input.processRunner ?? runLocalAsrProcess;

  try {
    await writeFile(pcmPath, sourcePcm, { flag: "wx", mode: 0o600 });
    if (await hashFile(pcmPath) !== sourcePlayedAudioSha256) throw new Error("ASR PCM staging corrupted input evidence");

    const ffmpegArgs = Object.freeze([
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", pcmPath,
      "-map_metadata", "-1", "-vn", "-fflags", "+bitexact", "-flags:a", "+bitexact",
      "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wavPath,
    ]);
    const conversion = await runChecked(processRunner, Object.freeze({
      executable: ffmpeg.path,
      args: ffmpegArgs,
      cwd: workspace,
      timeoutMs,
    }), "ffmpeg conversion");
    const wavMetadata = await lstat(wavPath).catch(() => null);
    if (!wavMetadata?.isFile() || wavMetadata.isSymbolicLink() || wavMetadata.size < 44) {
      throw new Error("ffmpeg conversion did not produce a regular WAV artifact");
    }
    const wavSha256 = await hashFile(wavPath);

    const whisperArgs = Object.freeze([
      "--model", model.path,
      "--file", wavPath,
      "--language", decoding.language,
      "--threads", String(decoding.threads),
      "--beam-size", String(decoding.beam_size),
      "--best-of", String(decoding.best_of),
      "--temperature", "0",
      "--max-context", "0",
      "--no-prints",
      "--no-timestamps",
      "--output-txt",
      "--output-file", transcriptPrefix,
    ]);
    const inference = await runChecked(processRunner, Object.freeze({
      executable: whisperCli.path,
      args: whisperArgs,
      cwd: workspace,
      timeoutMs,
    }), "whisper.cpp inference");
    const transcriptMetadata = await lstat(transcriptPath).catch(() => null);
    if (!transcriptMetadata?.isFile() || transcriptMetadata.isSymbolicLink()) {
      throw new Error("whisper.cpp did not produce a regular transcript artifact");
    }
    const transcriptBytes = await readFile(transcriptPath);
    const transcript = normalizeTranscript(transcriptBytes);
    const transcriptUtf8Length = Buffer.byteLength(transcript, "utf8");
    const processedThroughSample = sourcePcm.byteLength / 2;
    const spans = transcriptUtf8Length === 0
      ? Object.freeze([])
      : Object.freeze([Object.freeze({
          span_id: "span-000" as const,
          text: transcript,
          utf8_start: 0 as const,
          utf8_end: transcriptUtf8Length,
          audio_start_sample: 0 as const,
          audio_end_sample: processedThroughSample,
          confidence_ppm: null,
        })]);
    const result: WhisperCppAsrNormalizedResult = Object.freeze({
      status: "completed",
      source_request_sha256: sourceRequestSha256,
      source_played_audio_sha256: sourcePlayedAudioSha256,
      source_chunk_sequence_sha256: sourceChunkSequenceSha256,
      language: decoding.language,
      transcript,
      processed_through_sample: processedThroughSample,
      no_speech_probability_ppm: null,
      spans,
    });
    const normalizedResultSha256 = sha256Hex(`${RESULT_DOMAIN}${canonicalJson(result)}`);

    if (prepared) {
      await verifyPreparedMetadata(verifiedToolchain);
    } else {
      await Promise.all([
        verifyPinnedFileUnchanged(whisperCli, "whisper.cpp CLI"),
        verifyPinnedFileUnchanged(model, "whisper.cpp model"),
        verifyPinnedFileUnchanged(ffmpeg, "ffmpeg"),
      ]);
    }
    if (await hashFile(pcmPath) !== sourcePlayedAudioSha256) throw new Error("ASR PCM evidence changed during execution");

    const receiptBody = Object.freeze({
      schema_version: 1 as const,
      receipt_type: "hacc_whisper_cpp_asr" as const,
      invocation_id: invocationId,
      run_id: runId,
      unit_id: unitId,
      source_request_sha256: sourceRequestSha256,
      source_played_audio_sha256: sourcePlayedAudioSha256,
      source_chunk_sequence_sha256: sourceChunkSequenceSha256,
      config_sha256: configSha256,
      toolchain_verification: prepared
        ? Object.freeze({ mode: "prepared_batch" as const, batch_id: prepared.batchId })
        : Object.freeze({ mode: "per_invocation_full_hash" as const, batch_id: null }),
      input: Object.freeze({
        encoding: "pcm16" as const,
        endianness: "little" as const,
        sample_rate_hz: 24_000 as const,
        channels: 1 as const,
        byte_length: sourcePcm.byteLength,
        sample_count: processedThroughSample,
        pcm_sha256: sourcePlayedAudioSha256,
      }),
      toolchain: Object.freeze({
        whisper_cpp_source_revision: config.whisperCppSourceRevision,
        whisper_cpp_version: whisperCppVersion,
        whisper_cli_path_sha256: sha256Hex(whisperCli.path),
        whisper_cli_sha256: whisperCli.sha256,
        model_id: modelId,
        model_revision: config.modelRevision,
        model_path_sha256: sha256Hex(model.path),
        model_sha256: model.sha256,
        ffmpeg_path_sha256: sha256Hex(ffmpeg.path),
        ffmpeg_sha256: ffmpeg.sha256,
      }),
      conversion: Object.freeze({
        profile: RESAMPLING_PROFILE,
        argv_sha256: sha256Hex(`${ARGV_DOMAIN}${canonicalJson(ffmpegArgs)}`),
        wav_sha256: wavSha256,
        wav_byte_length: wavMetadata.size,
        runtime_ms: conversion.runtimeMs,
      }),
      inference: Object.freeze({
        argv_sha256: sha256Hex(`${ARGV_DOMAIN}${canonicalJson(whisperArgs)}`),
        runtime_ms: inference.runtimeMs,
        stdout_sha256: stdoutHash(inference),
        stderr_sha256: stderrHash(inference),
        exit_code: 0 as const,
      }),
      transcript_file_sha256: sha256Hex(transcriptBytes),
      normalized_result_sha256: normalizedResultSha256,
      result,
    });
    const receipt: WhisperCppAsrReceipt = Object.freeze({
      ...receiptBody,
      receipt_sha256: sha256Hex(`${RECEIPT_DOMAIN}${canonicalJson(receiptBody)}`),
    });
    return Object.freeze({
      receipt,
      canonicalReceiptJson: `${canonicalJson(receipt)}\n`,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

/** Backward-compatible one-shot API: fully hashes every pin before and after the invocation. */
export async function runWhisperCppAsr(input: Readonly<{
  config: WhisperCppAsrConfig;
  source: WhisperCppAsrSource;
  processRunner?: LocalAsrProcessRunner;
  temporaryRoot?: string;
}>): Promise<WhisperCppAsrRun> {
  return executeWhisperCppAsr(input);
}

function preparedState(handle: PreparedWhisperCppAsrToolchain): PreparedToolchainState {
  const state = preparedToolchainStates.get(handle);
  if (handle?.[PREPARED_TOOLCHAIN] !== true || !state) {
    throw new Error("prepared ASR toolchain handle is not authentic");
  }
  return state;
}

/**
 * Run one ASR invocation using a prepared toolchain. This performs only cheap
 * stat/inode identity checks; the batch finalizer performs the closing hashes.
 */
export async function runPreparedWhisperCppAsr(input: Readonly<{
  toolchain: PreparedWhisperCppAsrToolchain;
  source: WhisperCppAsrSource;
  processRunner?: LocalAsrProcessRunner;
  temporaryRoot?: string;
}>): Promise<WhisperCppAsrRun> {
  const state = preparedState(input.toolchain);
  if (state.status !== "active") throw new Error("prepared ASR toolchain is no longer active");
  const invocationId = safeId(input.source.invocationId, "ASR invocation ID");
  if (state.reservedInvocationIds.has(invocationId)) {
    throw new Error("prepared ASR batch invocation ID is duplicated");
  }
  state.reservedInvocationIds.add(invocationId);
  state.activeRuns += 1;
  try {
    const run = await executeWhisperCppAsr({
      config: state.toolchain.config,
      source: input.source,
      processRunner: input.processRunner,
      temporaryRoot: input.temporaryRoot,
    }, { batchId: state.batchId, toolchain: state.toolchain });
    state.invocationReceipts.set(invocationId, run.receipt.receipt_sha256);
    return run;
  } catch (error) {
    state.reservedInvocationIds.delete(invocationId);
    throw error;
  } finally {
    state.activeRuns -= 1;
  }
}

/**
 * Close a prepared batch, re-hash every pinned artifact exactly once, bind the
 * complete invocation inventory, and permanently invalidate the handle.
 */
export async function finalizeWhisperCppAsrToolchain(
  handle: PreparedWhisperCppAsrToolchain
): Promise<WhisperCppAsrBatchFinalization> {
  const state = preparedState(handle);
  if (state.status !== "active") throw new Error("prepared ASR toolchain is no longer active");
  if (state.activeRuns !== 0) throw new Error("prepared ASR toolchain has active invocations");
  state.status = "finalizing";
  try {
    await Promise.all([
      verifyPinnedFileUnchanged(state.toolchain.whisperCli, "whisper.cpp CLI"),
      verifyPinnedFileUnchanged(state.toolchain.model, "whisper.cpp model"),
      verifyPinnedFileUnchanged(state.toolchain.ffmpeg, "ffmpeg"),
    ]);
    const invocationReceipts = Object.freeze(
      [...state.invocationReceipts.entries()]
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([invocationId, receiptSha256]) => Object.freeze({
          invocation_id: invocationId,
          receipt_sha256: receiptSha256,
        }))
    );
    const inventorySha256 = sha256Hex(`${BATCH_INVENTORY_DOMAIN}${canonicalJson(invocationReceipts)}`);
    const body = Object.freeze({
      schema_version: 1 as const,
      receipt_type: "hacc_whisper_cpp_asr_batch_finalization" as const,
      batch_id: state.batchId,
      config_sha256: state.toolchain.configSha256,
      invocation_count: invocationReceipts.length,
      invocation_receipts: invocationReceipts,
      invocation_inventory_sha256: inventorySha256,
      toolchain: Object.freeze({
        whisper_cli_sha256: state.toolchain.whisperCli.sha256,
        model_sha256: state.toolchain.model.sha256,
        ffmpeg_sha256: state.toolchain.ffmpeg.sha256,
      }),
    });
    return Object.freeze({
      ...body,
      finalization_sha256: sha256Hex(`${BATCH_FINALIZATION_DOMAIN}${canonicalJson(body)}`),
    });
  } finally {
    state.status = "finalized";
  }
}
