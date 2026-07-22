import { readFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPinnedMacOsLc4DevAudioRenderer,
  inspectLc4DevAudioToolchain,
  materializeLc4DevelopmentAudio,
  type Lc4DevAudioToolchain,
} from "./lc4-development-audio-materializer";

type Io = Readonly<{
  stdout(value: string): void;
  stderr(value: string): void;
}>;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function parseFlags(args: readonly string[]): Readonly<Record<string, string>> {
  if (args.length % 2 !== 0) throw new Error("LC4-DEV audio flags require --name value pairs");
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!;
    const value = args[index + 1]!;
    if (!key.startsWith("--") || value.startsWith("--") || result[key]) throw new Error("LC4-DEV audio flags are malformed or duplicated");
    result[key] = value;
  }
  return Object.freeze(result);
}

function requireExactFlags(flags: Readonly<Record<string, string>>, expected: readonly string[]): void {
  if (JSON.stringify(Object.keys(flags).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`LC4-DEV audio command requires exactly: ${[...expected].sort().join(", ")}`);
  }
}

function assertOutsideRepo(path: string): string {
  const normalized = resolve(path);
  if (normalized !== path) throw new Error("LC4-DEV audio output must be an absolute normalized path");
  if (normalized === REPO_ROOT || normalized.startsWith(`${REPO_ROOT}${sep}`)) {
    throw new Error("LC4-DEV audio artifacts must be written outside the repository");
  }
  return normalized;
}

async function loadToolchain(path: string): Promise<Lc4DevAudioToolchain> {
  const bytes = await readFile(resolve(path));
  if (bytes.byteLength < 2 || bytes.byteLength > 64 * 1024) throw new Error("LC4-DEV toolchain JSON has an invalid size");
  const parsed = JSON.parse(bytes.toString("utf8")) as Lc4DevAudioToolchain;
  return parsed;
}

export async function runLc4DevelopmentAudioCli(
  args: readonly string[],
  io: Io = {
    stdout: (value) => process.stdout.write(`${value}\n`),
    stderr: (value) => process.stderr.write(`${value}\n`),
  },
): Promise<number> {
  try {
    const command = args[0];
    const flags = parseFlags(args.slice(1));
    if (command === "inspect-toolchain") {
      requireExactFlags(flags, ["--ffmpeg"]);
      io.stdout(JSON.stringify(await inspectLc4DevAudioToolchain({ ffmpegPath: flags["--ffmpeg"]! })));
      return 0;
    }
    if (command === "materialize") {
      requireExactFlags(flags, ["--output", "--toolchain"]);
      const outputRoot = assertOutsideRepo(flags["--output"]!);
      const toolchain = await loadToolchain(flags["--toolchain"]!);
      const renderer = await createPinnedMacOsLc4DevAudioRenderer(toolchain);
      const result = await materializeLc4DevelopmentAudio({ outputRoot, renderer });
      io.stdout(JSON.stringify({
        protocol_id: result.manifest.protocol_id,
        output_root: outputRoot,
        manifest_sha256: result.manifest.manifest_sha256,
        repair_manifest_sha256: result.repairManifest.repair_manifest_sha256,
        prepare_fragment_sha256: result.prepareFragment.fragment_sha256,
        canonical_bindings: result.manifest.caller_audio_bindings.length,
        repair_bindings: result.repairManifest.repair_audio_bindings.length,
        provider_calls_made: false,
      }));
      return 0;
    }
    throw new Error("usage: lc4-development-audio <inspect-toolchain|materialize>");
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : "LC4-DEV audio command failed");
    return 1;
  }
}
