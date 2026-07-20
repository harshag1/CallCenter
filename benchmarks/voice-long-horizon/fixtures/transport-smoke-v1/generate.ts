#!/usr/bin/env tsx

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCallerPcmDescriptor,
  createDeterministicTransportSmokeFixtureManifest,
  deterministicTransportSmokeSynthesis,
  renderDeterministicTransportSignalPcm,
  serializeCallerAudioFixtureManifest,
} from "../../../../web/lib/benchmark/audio-fixtures";
import { canonicalJson, sha256Hex } from "../../../../web/lib/benchmark/artifacts";
import { BenchmarkScenarioSchema } from "../../../../web/lib/benchmark/scenario-schema";

const FIXTURE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(FIXTURE_DIRECTORY, "..", "..", "..", "..");
const SCENARIO_PATH = join(
  REPOSITORY_ROOT,
  "benchmarks",
  "voice-long-horizon",
  "scenarios",
  "transport-smoke-v1.json"
);
const FIXTURE_LOADER_PATH = join(
  REPOSITORY_ROOT,
  "web",
  "lib",
  "benchmark",
  "audio-fixtures.ts"
);
const FIXED_ARTIFACT_TIMESTAMP = "2026-07-20T00:00:00.000Z";

function safeOutputName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)
    && name !== "."
    && name !== "..";
}

type VerifiedOutputDirectory = Readonly<{
  path: string;
  device: bigint;
  inode: bigint;
  handle: FileHandle;
}>;

async function openVerifiedOutputDirectory(
  directory: string
): Promise<VerifiedOutputDirectory> {
  const path = resolve(directory);
  let pathStat;
  try {
    pathStat = await lstat(path, { bigint: true });
  } catch {
    throw new Error("fixture output directory is unavailable");
  }
  if (pathStat.isSymbolicLink() || !pathStat.isDirectory()) {
    throw new Error("fixture output directory is not a safe regular directory");
  }
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(path);
  } catch {
    throw new Error("fixture output directory is unavailable");
  }
  if (canonicalPath !== path) {
    throw new Error("fixture output directory contains a symbolic link");
  }

  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
  } catch {
    throw new Error("fixture output directory could not be opened safely");
  }
  try {
    const descriptorStat = await handle.stat({ bigint: true });
    if (
      !descriptorStat.isDirectory()
      || descriptorStat.dev !== pathStat.dev
      || descriptorStat.ino !== pathStat.ino
    ) {
      throw new Error("fixture output directory changed before secure open");
    }
    return Object.freeze({
      path,
      device: descriptorStat.dev,
      inode: descriptorStat.ino,
      handle,
    });
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function assertVerifiedOutputDirectory(
  directory: VerifiedOutputDirectory
): Promise<void> {
  let pathStat;
  let canonicalPath: string;
  try {
    [pathStat, canonicalPath] = await Promise.all([
      lstat(directory.path, { bigint: true }),
      realpath(directory.path),
    ]);
  } catch {
    throw new Error("fixture output directory changed during operation");
  }
  const descriptorStat = await directory.handle.stat({ bigint: true });
  if (
    pathStat.isSymbolicLink()
    || !pathStat.isDirectory()
    || canonicalPath !== directory.path
    || !descriptorStat.isDirectory()
    || pathStat.dev !== directory.device
    || pathStat.ino !== directory.inode
    || descriptorStat.dev !== directory.device
    || descriptorStat.ino !== directory.inode
  ) {
    throw new Error("fixture output directory changed during operation");
  }
}

async function existingSafeOutputStat(
  path: string,
  name: string
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`fixture output ${name} is unavailable`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`fixture output ${name} is not a safe regular file`);
  }
  if (stat.nlink !== 1) {
    throw new Error(`fixture output ${name} has multiple hard links`);
  }
  return stat;
}

/** Read the same no-follow, single-link file descriptor that is verified. */
export async function readFixtureOutputSecurely(
  directory: string,
  name: string
): Promise<Uint8Array | null> {
  if (!safeOutputName(name)) throw new Error("fixture output name is unsafe");
  const verifiedDirectory = await openVerifiedOutputDirectory(directory);
  try {
    await assertVerifiedOutputDirectory(verifiedDirectory);
    const path = join(verifiedDirectory.path, name);
    const pathStat = await existingSafeOutputStat(path, name);
    if (!pathStat) return null;
    let handle: FileHandle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      throw new Error(`fixture output ${name} could not be opened safely`);
    }
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== BigInt(1)) {
        throw new Error(`fixture output ${name} is not a single-link regular file`);
      }
      if (
        before.dev !== BigInt(pathStat.dev)
        || before.ino !== BigInt(pathStat.ino)
        || before.size !== BigInt(pathStat.size)
      ) {
        throw new Error(`fixture output ${name} changed before secure open`);
      }
      const bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      if (
        before.dev !== after.dev
        || before.ino !== after.ino
        || before.size !== after.size
        || before.nlink !== after.nlink
        || before.mtimeNs !== after.mtimeNs
        || before.ctimeNs !== after.ctimeNs
      ) {
        throw new Error(`fixture output ${name} changed while being read`);
      }
      await assertVerifiedOutputDirectory(verifiedDirectory);
      return bytes;
    } finally {
      await handle.close();
    }
  } finally {
    await verifiedDirectory.handle.close();
  }
}

/**
 * Replace one output without ever opening the destination for writing.
 *
 * Existing symlinks and multi-link files fail closed. The exclusive temporary
 * file lives beside the destination, is synced, and is atomically renamed.
 * A race that changes the destination after validation cannot mutate the
 * raced-to inode because rename replaces the directory entry without following
 * it.
 */
export async function writeFixtureOutputAtomically(
  directory: string,
  name: string,
  bytes: Uint8Array
): Promise<void> {
  if (!safeOutputName(name)) throw new Error("fixture output name is unsafe");
  const verifiedDirectory = await openVerifiedOutputDirectory(directory);
  const path = join(verifiedDirectory.path, name);
  const temporaryPath = join(
    verifiedDirectory.path,
    `.${basename(name)}.${process.pid}.${randomUUID()}.tmp`
  );
  let handle: FileHandle | undefined;
  let renamed = false;
  try {
    await assertVerifiedOutputDirectory(verifiedDirectory);
    await existingSafeOutputStat(path, name);
    handle = await open(
      temporaryPath,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | constants.O_NOFOLLOW,
      0o600
    );
    await handle.writeFile(bytes);
    await handle.chmod(0o644);
    await handle.sync();
    await handle.close();
    handle = undefined;

    // Re-check for a pre-existing unsafe target immediately before replacement.
    await assertVerifiedOutputDirectory(verifiedDirectory);
    await existingSafeOutputStat(path, name);
    await rename(temporaryPath, path);
    renamed = true;
    await verifiedDirectory.handle.sync();
    const installed = await existingSafeOutputStat(path, name);
    if (!installed) throw new Error(`fixture output ${name} was not installed`);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    if (!renamed) {
      await assertVerifiedOutputDirectory(verifiedDirectory)
        .then(() => rm(temporaryPath, { force: true }))
        .catch(() => undefined);
    }
    await verifiedDirectory.handle.close().catch(() => undefined);
  }
}

async function buildOutputs(): Promise<Readonly<Record<string, Uint8Array>>> {
  const scenarioFileBytes = await readFile(SCENARIO_PATH);
  const fixtureLoaderBytes = await readFile(FIXTURE_LOADER_PATH);
  const scenario = BenchmarkScenarioSchema.parse(
    JSON.parse(scenarioFileBytes.toString("utf8"))
  );
  const caller = scenario.caller;
  const turn = caller.turns?.[0];
  if (
    scenario.id !== "transport-smoke-v1"
    || scenario.version !== "1.1.0"
    || caller.turns?.length !== 1
    || turn?.id !== "turn_01"
    || turn.utterance !== "Beep. Beep. Beep."
  ) {
    throw new Error("transport-smoke scenario identity or exact audible label changed");
  }

  const synthesis = deterministicTransportSmokeSynthesis();
  const pcm16 = renderDeterministicTransportSignalPcm(synthesis, 16_000);
  const pcm24 = renderDeterministicTransportSignalPcm(synthesis, 24_000);
  const generatorBytes = await readFile(fileURLToPath(import.meta.url));
  const manifest = createDeterministicTransportSmokeFixtureManifest({
    generatedAt: FIXED_ARTIFACT_TIMESTAMP,
    scenario: {
      id: scenario.id,
      version: scenario.version,
      canonical_sha256: sha256Hex(canonicalJson(scenario)),
    },
    turns: [{ id: turn.id, text: turn.utterance, pause_after_ms: 0 }],
    generatorSha256: sha256Hex(generatorBytes),
    generatedTurn: {
      caller_turn_id: turn.id,
      renditions: {
        pcm16le_mono_16000: createCallerPcmDescriptor({
          path: "turn_01.pcm16le-mono-16000.pcm",
          bytes: pcm16,
          sampleRateHz: 16_000,
        }),
        pcm16le_mono_24000: createCallerPcmDescriptor({
          path: "turn_01.pcm16le-mono-24000.pcm",
          bytes: pcm24,
          sampleRateHz: 24_000,
        }),
      },
    },
  });
  const manifestBytes = Buffer.from(serializeCallerAudioFixtureManifest(manifest), "utf8");
  const fixtureRoot = "benchmarks/voice-long-horizon/fixtures/transport-smoke-v1";
  const scenarioPath = "benchmarks/voice-long-horizon/scenarios/transport-smoke-v1.json";
  const freezeInputBytes = Buffer.from(`${canonicalJson({
    schema_version: 1,
    purpose: "c3-transport-compatibility-only",
    fixture_root: fixtureRoot,
    fixture_manifest_sha256: manifest.manifest_sha256,
    fixture_manifest_file_sha256: sha256Hex(manifestBytes),
    caller_sequence_sha256: manifest.caller_sequence_sha256,
    audio_set_sha256: manifest.audio_set_sha256,
    scenario_canonical_sha256: manifest.scenario.canonical_sha256,
    scenario_registry_key:
      `${manifest.scenario.id}@${manifest.scenario.version}#sha256:${manifest.scenario.canonical_sha256}`,
    required_freeze_bundle: [
      { path: scenarioPath, sha256: sha256Hex(scenarioFileBytes) },
      { path: "web/lib/benchmark/audio-fixtures.ts", sha256: sha256Hex(fixtureLoaderBytes) },
      { path: `${fixtureRoot}/generate.ts`, sha256: sha256Hex(generatorBytes) },
      { path: `${fixtureRoot}/fixture-manifest.json`, sha256: sha256Hex(manifestBytes) },
      { path: `${fixtureRoot}/turn_01.pcm16le-mono-16000.pcm`, sha256: sha256Hex(pcm16) },
      { path: `${fixtureRoot}/turn_01.pcm16le-mono-24000.pcm`, sha256: sha256Hex(pcm24) },
    ],
    duration_ms: pcm16.byteLength / 2 / 16_000 * 1_000,
    total_pcm_bytes: pcm16.byteLength + pcm24.byteLength,
    semantic_scope: manifest.synthesis.semantic_content,
    license_spdx: manifest.synthesis.license_spdx,
  })}\n`, "utf8");

  return Object.freeze({
    "turn_01.pcm16le-mono-16000.pcm": pcm16,
    "turn_01.pcm16le-mono-24000.pcm": pcm24,
    "fixture-manifest.json": manifestBytes,
    "freeze-input.json": freezeInputBytes,
  });
}

async function main(): Promise<void> {
  const check = process.argv.slice(2).includes("--check");
  const unknown = process.argv.slice(2).filter((argument) => argument !== "--check");
  if (unknown.length > 0) throw new Error(`unknown argument: ${unknown[0]}`);
  const outputs = await buildOutputs();
  const mismatches: string[] = [];
  for (const [name, expected] of Object.entries(outputs)) {
    if (check) {
      const actual = await readFixtureOutputSecurely(FIXTURE_DIRECTORY, name);
      if (!actual) {
        mismatches.push(`${name}: missing`);
        continue;
      }
      if (!Buffer.from(actual).equals(Buffer.from(expected))) {
        mismatches.push(`${name}: differs`);
      }
    } else {
      await writeFixtureOutputAtomically(FIXTURE_DIRECTORY, name, expected);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`transport fixture check failed: ${mismatches.join(", ")}`);
  }
  process.stdout.write(`${check ? "verified" : "generated"} ${Object.keys(outputs).length} deterministic fixture files\n`);
}

const executedAsScript = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (executedAsScript) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "transport fixture generation failed"}\n`);
    process.exitCode = 1;
  });
}
