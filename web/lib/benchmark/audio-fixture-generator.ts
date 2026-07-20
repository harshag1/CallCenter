import { spawn } from "node:child_process";
import type { SpawnOptionsWithoutStdio } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  CALLER_AUDIO_MANIFEST_FILE,
  MacosCallerAudioFixtureManifest,
  CallerAudioRendition,
  CallerAudioScenarioIdentity,
  CallerAudioToolchain,
  CallerAudioTurn,
  GeneratedCallerAudioTurn,
  createCallerAudioFixtureManifest,
  createCallerPcmDescriptor,
  hashCallerAudioSequence,
  serializeCallerAudioFixtureManifest,
  verifyCallerAudioFixture,
} from "./audio-fixtures";
import { sha256Hex } from "./artifacts";

export type BenchmarkProcessRequest = Readonly<{
  executable: string;
  args: readonly string[];
  stdin?: string | Uint8Array;
  cwd?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  timeoutMs?: number;
  signal?: AbortSignal;
}>;

export type BenchmarkProcessResult = Readonly<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}>;

export type BenchmarkProcessRunner = (
  request: BenchmarkProcessRequest
) => Promise<BenchmarkProcessResult>;

export type PrepareCallerAudioFixtureOptions = Readonly<{
  /** Runtime guard: synthesis is never a paid-trial operation. */
  phase: "fixture-preparation";
  rootDirectory: string;
  scenario: CallerAudioScenarioIdentity;
  turns: readonly CallerAudioTurn[];
  voice: string;
  rateWpm?: number;
  sayExecutable?: string;
  ffmpegExecutable?: string;
  swVersExecutable?: string;
  otoolExecutable?: string;
  commandTimeoutMs?: number;
  processRunner?: BenchmarkProcessRunner;
  environment?: Readonly<Record<string, string | undefined>>;
  now?: () => string;
}>;

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const CONVERSION_PROFILE = "pcm16le-mono-libsoxr-v1";

function sanitizedToolEnvironment(
  source: Readonly<Record<string, string | undefined>>
): NodeJS.ProcessEnv {
  const nodeEnv = source.NODE_ENV === "development" || source.NODE_ENV === "test"
    ? source.NODE_ENV
    : "production";
  return Object.freeze({
    NODE_ENV: nodeEnv,
    PATH: source.PATH,
    HOME: source.HOME,
    TMPDIR: source.TMPDIR,
    USER: source.USER,
    LOGNAME: source.LOGNAME,
    __CF_USER_TEXT_ENCODING: source.__CF_USER_TEXT_ENCODING,
  }) as NodeJS.ProcessEnv;
}

function appendChunk(chunks: Buffer[], chunk: Buffer, state: { size: number }): void {
  state.size += chunk.byteLength;
  if (state.size > MAX_CAPTURE_BYTES) throw new Error("process output exceeded 2 MB");
  chunks.push(chunk);
}

/** Spawn directly with shell=false and feed caller text only through stdin. */
export const runBenchmarkProcess: BenchmarkProcessRunner = async (request) => {
  const requestedEnvironment = sanitizedToolEnvironment(request.environment ?? process.env);
  const environment = {
    ...requestedEnvironment,
    LC_ALL: "C",
    LANG: "C",
    TZ: "UTC",
  };

  return new Promise<BenchmarkProcessResult>((resolvePromise, rejectPromise) => {
    const spawnOptions: SpawnOptionsWithoutStdio = {
      cwd: request.cwd,
      env: environment,
      shell: false,
      windowsHide: true,
      signal: request.signal,
    };
    const child = spawn(request.executable, [...request.args], spawnOptions);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const stdoutState = { size: 0 };
    const stderrState = { size: 0 };
    let settled = false;

    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      rejectPromise(error);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      try {
        appendChunk(stdout, chunk, stdoutState);
      } catch (error) {
        rejectOnce(error instanceof Error ? error : new Error("process stdout overflow"));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      try {
        appendChunk(stderr, chunk, stderrState);
      } catch (error) {
        rejectOnce(error instanceof Error ? error : new Error("process stderr overflow"));
      }
    });
    child.on("error", (error) => rejectOnce(new Error(`Unable to start benchmark process: ${error.message}`)));
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      resolvePromise(Object.freeze({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }));
    });

    const stdin = request.stdin === undefined
      ? undefined
      : typeof request.stdin === "string"
        ? Buffer.from(request.stdin, "utf8")
        : Buffer.from(request.stdin);
    child.stdin.on("error", (error) => rejectOnce(new Error(`Unable to write benchmark process stdin: ${error.message}`)));
    child.stdin.end(stdin);
  });
};

async function runChecked(
  runner: BenchmarkProcessRunner,
  label: string,
  request: BenchmarkProcessRequest
): Promise<BenchmarkProcessResult> {
  const timeoutMs = request.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
    throw new Error(`${label} has an invalid timeout`);
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = request.signal
    ? AbortSignal.any([request.signal, timeoutSignal])
    : timeoutSignal;
  const abortPromise = new Promise<never>((_, rejectPromise) => {
    const rejectForAbort = (): void => {
      rejectPromise(new Error(timeoutSignal.aborted ? `${label} timed out` : `${label} was aborted`));
    };
    if (signal.aborted) rejectForAbort();
    else signal.addEventListener("abort", rejectForAbort, { once: true });
  });
  let result: BenchmarkProcessResult;
  try {
    result = await Promise.race([
      runner(Object.freeze({ ...request, timeoutMs, signal })),
      abortPromise,
    ]);
  } catch (error) {
    if (error instanceof Error && (error.message === `${label} timed out` || error.message === `${label} was aborted`)) {
      throw error;
    }
    throw new Error(`${label} failed to run`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${result.exitCode ?? "null"}`);
  }
  return result;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      const code = (error as { code?: unknown }).code;
      if (code === "ENOENT" || code === "ENOTDIR") return false;
    }
    throw error;
  }
}

async function resolveExecutable(command: string, environment: Readonly<Record<string, string | undefined>>): Promise<string> {
  const candidates = isAbsolute(command)
    ? [command]
    : (environment.PATH ?? process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue through PATH. The final error intentionally omits local paths.
    }
  }
  throw new Error(`Required audio fixture executable is unavailable: ${command}`);
}

function firstNonEmptyLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function parseLibsoxrLibraryId(otoolOutput: string): string | null {
  for (const line of otoolOutput.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!/libsoxr/i.test(trimmed)) continue;
    const match = trimmed.match(/^(.*?)\s+\(compatibility version /);
    return (match?.[1] ?? trimmed.split(/\s+/)[0]) || null;
  }
  return null;
}

function libsoxrVersion(path: string): string {
  const cellarVersion = path.match(/\/libsoxr\/([^/]+)\//i)?.[1];
  if (cellarVersion) return cellarVersion;
  return basename(path).match(/libsoxr(?:\.so)?[._-]([0-9]+(?:\.[0-9]+)*)/i)?.[1] ?? "unreported";
}

function conversionArgs(
  sampleRateHz: 16_000 | 24_000,
  sourceAiff: string,
  outputPcm: string
): readonly string[] {
  return Object.freeze([
    "-nostdin",
    "-hide_banner",
    "-loglevel", "error",
    "-xerror",
    "-bitexact",
    "-threads", "1",
    "-filter_threads", "1",
    "-i", sourceAiff,
    "-map", "0:a:0",
    "-map_metadata", "-1",
    "-vn",
    "-sn",
    "-dn",
    "-af", `aresample=resampler=soxr:precision=28:cheby=0:dither_method=none:osr=${sampleRateHz}`,
    "-ac", "1",
    "-ar", String(sampleRateHz),
    "-c:a", "pcm_s16le",
    "-f", "s16le",
    "-n",
    outputPcm,
  ]);
}

function templateConversionArgs(sampleRateHz: 16_000 | 24_000): string[] {
  return [...conversionArgs(sampleRateHz, "<SOURCE_AIFF>", "<OUTPUT_PCM>")];
}

async function fingerprintToolchain(input: {
  runner: BenchmarkProcessRunner;
  environment: Readonly<Record<string, string | undefined>>;
  sayExecutable: string;
  ffmpegExecutable: string;
  swVersExecutable: string;
  otoolExecutable: string;
  commandTimeoutMs: number;
  voice: string;
}): Promise<Readonly<{
  toolchain: CallerAudioToolchain;
  sayExecutable: string;
  ffmpegExecutable: string;
  libsoxrPath: string;
}>> {
  const sayExecutable = await resolveExecutable(input.sayExecutable, input.environment);
  const ffmpegExecutable = await resolveExecutable(input.ffmpegExecutable, input.environment);
  const swVersExecutable = await resolveExecutable(input.swVersExecutable, input.environment);
  const otoolExecutable = await resolveExecutable(input.otoolExecutable, input.environment);

  const [productVersion, buildVersion, ffmpegVersion, ffmpegBuild, otool, sayInventory] = await Promise.all([
    runChecked(input.runner, "macOS product-version probe", {
      executable: swVersExecutable,
      args: ["-productVersion"],
      environment: input.environment,
      timeoutMs: input.commandTimeoutMs,
    }),
    runChecked(input.runner, "macOS build-version probe", {
      executable: swVersExecutable,
      args: ["-buildVersion"],
      environment: input.environment,
      timeoutMs: input.commandTimeoutMs,
    }),
    runChecked(input.runner, "FFmpeg version probe", {
      executable: ffmpegExecutable,
      args: ["-version"],
      environment: input.environment,
      timeoutMs: input.commandTimeoutMs,
    }),
    runChecked(input.runner, "FFmpeg build probe", {
      executable: ffmpegExecutable,
      args: ["-buildconf"],
      environment: input.environment,
      timeoutMs: input.commandTimeoutMs,
    }),
    runChecked(input.runner, "FFmpeg library probe", {
      executable: otoolExecutable,
      args: ["-L", ffmpegExecutable],
      environment: input.environment,
      timeoutMs: input.commandTimeoutMs,
    }),
    runChecked(input.runner, "macOS voice inventory probe", {
      executable: sayExecutable,
      args: ["-v", "?"],
      environment: input.environment,
      timeoutMs: input.commandTimeoutMs,
    }),
  ]);

  const buildOutput = `${ffmpegBuild.stdout}\n${ffmpegBuild.stderr}`;
  if (!/(?:^|\s)--enable-libsoxr(?:\s|$)/.test(buildOutput)) {
    throw new Error("FFmpeg was not built with libsoxr support");
  }
  const product = firstNonEmptyLine(productVersion.stdout);
  const build = firstNonEmptyLine(buildVersion.stdout);
  const version = firstNonEmptyLine(`${ffmpegVersion.stdout}\n${ffmpegVersion.stderr}`);
  if (!product || !build || !version) throw new Error("Audio toolchain version probe returned an empty value");
  const voiceInventory = `${sayInventory.stdout}\n${sayInventory.stderr}`.trim();
  const selectedVoiceMetadata = voiceInventory
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .find((line) => line === input.voice || line.startsWith(`${input.voice} `));
  if (!voiceInventory || !selectedVoiceMetadata) {
    throw new Error("The requested macOS voice is absent from the recorded voice inventory");
  }

  const libraryId = parseLibsoxrLibraryId(`${otool.stdout}\n${otool.stderr}`);
  if (!libraryId || !isAbsolute(libraryId)) {
    throw new Error("Unable to identify the absolute libsoxr library used by FFmpeg");
  }
  const libsoxrPath = await realpath(libraryId);
  const [sayBinary, ffmpegBinary, libsoxrBinary] = await Promise.all([
    readFile(sayExecutable),
    readFile(ffmpegExecutable),
    readFile(libsoxrPath),
  ]);

  const toolchain: CallerAudioToolchain = {
    macos: {
      product_version: product,
      build_version: build,
    },
    say: {
      implementation: "macos-say",
      binary_sha256: sha256Hex(sayBinary),
      version_source: "macos-bundle",
      voice_inventory_sha256: sha256Hex(voiceInventory),
      selected_voice_metadata_sha256: sha256Hex(selectedVoiceMetadata),
      voice_asset_fingerprint_kind: "inventory-metadata-only",
    },
    ffmpeg: {
      version,
      binary_sha256: sha256Hex(ffmpegBinary),
      build_configuration_sha256: sha256Hex(buildOutput),
      libsoxr_enabled: true,
      libsoxr_library_name: basename(libsoxrPath),
      libsoxr_version: libsoxrVersion(libsoxrPath),
      libsoxr_binary_sha256: sha256Hex(libsoxrBinary),
      conversion_profile: CONVERSION_PROFILE,
      argv_by_rendition: {
        pcm16le_mono_16000: templateConversionArgs(16_000),
        pcm16le_mono_24000: templateConversionArgs(24_000),
      },
    },
  };
  return Object.freeze({ toolchain, sayExecutable, ffmpegExecutable, libsoxrPath });
}

async function assertToolchainBinariesUnchanged(input: Readonly<{
  toolchain: CallerAudioToolchain;
  sayExecutable: string;
  ffmpegExecutable: string;
  libsoxrPath: string;
}>): Promise<void> {
  let sayBinary: Buffer;
  let ffmpegBinary: Buffer;
  let libsoxrBinary: Buffer;
  try {
    [sayBinary, ffmpegBinary, libsoxrBinary] = await Promise.all([
      readFile(input.sayExecutable),
      readFile(input.ffmpegExecutable),
      readFile(input.libsoxrPath),
    ]);
  } catch {
    throw new Error("Audio fixture toolchain could not be re-verified after synthesis");
  }
  if (
    sha256Hex(sayBinary) !== input.toolchain.say.binary_sha256
    || sha256Hex(ffmpegBinary) !== input.toolchain.ffmpeg.binary_sha256
    || sha256Hex(libsoxrBinary) !== input.toolchain.ffmpeg.libsoxr_binary_sha256
  ) {
    throw new Error("Audio fixture toolchain changed during synthesis");
  }
}

function renditionDetails(rendition: CallerAudioRendition): Readonly<{
  sampleRateHz: 16_000 | 24_000;
  filename: string;
}> {
  return rendition === "pcm16le_mono_16000"
    ? { sampleRateHz: 16_000, filename: "pcm16le-mono-16000.pcm" }
    : { sampleRateHz: 24_000, filename: "pcm16le-mono-24000.pcm" };
}

/**
 * Preparation-only entrypoint. It refuses existing fixture destinations and
 * never has a `paid-trial` mode or an implicit regeneration fallback.
 */
export async function prepareCallerAudioFixture(
  options: PrepareCallerAudioFixtureOptions
): Promise<MacosCallerAudioFixtureManifest> {
  if ((options as { phase?: string }).phase !== "fixture-preparation") {
    throw new Error("Caller audio synthesis is allowed only during fixture preparation, never a paid trial");
  }
  if (!options.voice || /[\0\r\n]/.test(options.voice) || options.voice.length > 128) {
    throw new Error("A single explicit macOS voice name is required");
  }
  const rateWpm = options.rateWpm ?? 175;
  if (!Number.isInteger(rateWpm) || rateWpm < 80 || rateWpm > 500) {
    throw new Error("rateWpm must be an integer from 80 through 500");
  }
  // Validate exact text, order, IDs, pauses, and size before touching disk or tools.
  hashCallerAudioSequence(options.turns);
  const commandTimeoutMs = options.commandTimeoutMs ?? 120_000;
  if (!Number.isSafeInteger(commandTimeoutMs) || commandTimeoutMs < 1 || commandTimeoutMs > 600_000) {
    throw new Error("commandTimeoutMs must be an integer from 1 through 600000");
  }
  const rootDirectory = resolve(options.rootDirectory);
  const finalTurnsDirectory = join(rootDirectory, "turns");
  const finalManifestPath = join(rootDirectory, CALLER_AUDIO_MANIFEST_FILE);
  await mkdir(rootDirectory, { recursive: true });
  const lockPath = join(rootDirectory, ".fixture-preparation.lock");
  let preparationLock;
  try {
    preparationLock = await open(lockPath, "wx", 0o600);
  } catch {
    throw new Error("Caller audio fixture preparation is already active or its lock requires recovery");
  }
  try {
    await preparationLock.writeFile(`${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`);
    await preparationLock.sync();
  } catch {
    await preparationLock.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
    throw new Error("Unable to establish the caller audio fixture preparation lock");
  }

  try {
    if (await pathExists(finalTurnsDirectory) || await pathExists(finalManifestPath)) {
      throw new Error("Frozen caller audio destination already exists; refusing to overwrite it");
    }

    const environment = sanitizedToolEnvironment(options.environment ?? process.env);
    const runner = options.processRunner ?? runBenchmarkProcess;
    const fingerprint = await fingerprintToolchain({
      runner,
      environment,
      sayExecutable: options.sayExecutable ?? "/usr/bin/say",
      ffmpegExecutable: options.ffmpegExecutable ?? "ffmpeg",
      swVersExecutable: options.swVersExecutable ?? "/usr/bin/sw_vers",
      otoolExecutable: options.otoolExecutable ?? "/usr/bin/otool",
      commandTimeoutMs,
      voice: options.voice,
    });

    const stagingDirectory = join(rootDirectory, `.fixture-staging-${randomUUID()}`);
    const stagingTurnsDirectory = join(stagingDirectory, "turns");
    const stagingSourcesDirectory = join(stagingDirectory, "sources");
    await mkdir(stagingTurnsDirectory, { recursive: true });
    await mkdir(stagingSourcesDirectory, { recursive: true });

    let publishedTurns = false;
    let publishedManifest = false;
    let temporaryManifestPath: string | null = null;
    try {
      const generatedTurns: GeneratedCallerAudioTurn[] = [];
      for (const [ordinal, turn] of options.turns.entries()) {
      const ordinalLabel = ordinal.toString().padStart(4, "0");
      const sourceAiff = join(stagingSourcesDirectory, `${ordinalLabel}.aiff`);
      await runChecked(runner, `macOS say synthesis for turn ${ordinal}`, {
        executable: fingerprint.sayExecutable,
        args: [
          "-v", options.voice,
          "-r", String(rateWpm),
          "-o", sourceAiff,
          "--file-format=AIFF",
        ],
        stdin: turn.text,
        environment,
        timeoutMs: commandTimeoutMs,
      });
      const sourceBytes = await readFile(sourceAiff);
      if (sourceBytes.byteLength === 0) throw new Error(`macOS say produced empty audio for turn ${ordinal}`);

      const turnDirectory = join(stagingTurnsDirectory, ordinalLabel);
      await mkdir(turnDirectory, { recursive: true });
      const descriptors = {} as Record<CallerAudioRendition, ReturnType<typeof createCallerPcmDescriptor>>;
      for (const rendition of ["pcm16le_mono_16000", "pcm16le_mono_24000"] as const) {
        const details = renditionDetails(rendition);
        const outputPath = join(turnDirectory, details.filename);
        await runChecked(runner, `FFmpeg ${rendition} conversion for turn ${ordinal}`, {
          executable: fingerprint.ffmpegExecutable,
          args: conversionArgs(details.sampleRateHz, sourceAiff, outputPath),
          environment,
          timeoutMs: commandTimeoutMs,
        });
        const pcm = await readFile(outputPath);
        descriptors[rendition] = createCallerPcmDescriptor({
          path: `turns/${ordinalLabel}/${details.filename}`,
          bytes: pcm,
          sampleRateHz: details.sampleRateHz,
        });
      }
      generatedTurns.push(Object.freeze({
        caller_turn_id: turn.id,
        source_aiff_sha256: sha256Hex(sourceBytes),
        renditions: Object.freeze(descriptors),
      }));
      }

      // A package manager or local process must not be able to swap a binary or
      // loaded resampler after provenance was recorded but before publication.
      await assertToolchainBinariesUnchanged(fingerprint);

      const manifest = createCallerAudioFixtureManifest({
        generatedAt: (options.now ?? (() => new Date().toISOString()))(),
        scenario: options.scenario,
        turns: options.turns,
        voice: options.voice,
        rateWpm,
        toolchain: fingerprint.toolchain,
        generatedTurns,
      });

      await rename(stagingTurnsDirectory, finalTurnsDirectory);
      publishedTurns = true;
      temporaryManifestPath = join(rootDirectory, `.${CALLER_AUDIO_MANIFEST_FILE}.${randomUUID()}.tmp`);
      const manifestFile = await open(temporaryManifestPath, "wx", 0o600);
      try {
        await manifestFile.writeFile(serializeCallerAudioFixtureManifest(manifest));
        await manifestFile.sync();
      } finally {
        await manifestFile.close();
      }
      // Hard-link publication is atomic and fails if another file won the path;
      // unlike rename, it can never overwrite an existing frozen manifest.
      await link(temporaryManifestPath, finalManifestPath);
      publishedManifest = true;
      await rm(temporaryManifestPath, { force: true });
      temporaryManifestPath = null;

      const verification = await verifyCallerAudioFixture({
        rootDirectory,
        expectedScenario: options.scenario,
        expectedTurns: options.turns,
        expectedManifestSha256: manifest.manifest_sha256,
      });
      if (!verification.valid) {
        throw new Error(`Generated caller audio did not verify: ${verification.errors.join("; ")}`);
      }
      return manifest;
    } catch (error) {
      if (temporaryManifestPath) await rm(temporaryManifestPath, { force: true });
      if (publishedManifest) await rm(finalManifestPath, { force: true });
      if (publishedTurns) await rm(finalTurnsDirectory, { recursive: true, force: true });
      throw error;
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  } finally {
    try {
      await preparationLock.close();
    } finally {
      await rm(lockPath, { force: true });
    }
  }
}
