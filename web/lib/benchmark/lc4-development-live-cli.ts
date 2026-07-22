import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  LC4_DEV_ADAPTER_BOUNDARY,
  LC4_DEV_EXECUTABLE_PIPELINE_BLOCKERS,
  LC4_DEV_LIVE_HARD_CEILING_MICRO_USD,
  LC4_DEV_LIVE_TIMEOUTS,
  createLc4DevLivePreflightArtifact,
  createLc4DevLivePrepareArtifact,
  createLc4DevLiveReportArtifact,
  type Lc4DevLivePreflightArtifact,
  type Lc4DevLivePrepareArtifact,
  type Lc4DevLiveRunArtifact,
} from "./lc4-development-live-runner";

type Io = Readonly<{
  stdout(value: string): void;
  stderr(value: string): void;
  now(): Date;
}>;

type Execute = (prepare: Lc4DevLivePrepareArtifact, preflight: Lc4DevLivePreflightArtifact) => Promise<Lc4DevLiveRunArtifact>;

function flags(args: readonly string[]): Readonly<Record<string, string>> {
  if (args.length % 2 !== 0) throw new Error("LC4-DEV CLI requires --flag value pairs");
  const parsed: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!;
    const value = args[index + 1]!;
    if (!key.startsWith("--") || value.startsWith("--") || parsed[key]) throw new Error("LC4-DEV CLI flags are malformed or duplicated");
    parsed[key] = value;
  }
  return Object.freeze(parsed);
}

function exact(actual: Readonly<Record<string, string>>, expected: readonly string[]): void {
  if (JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`LC4-DEV CLI requires exactly: ${[...expected].sort().join(", ")}`);
  }
}

async function json<T>(path: string): Promise<T> {
  const bytes = await readFile(resolve(path));
  if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024 * 1024) throw new Error("LC4-DEV input JSON has an invalid size");
  return JSON.parse(bytes.toString("utf8")) as T;
}

export async function runLc4DevelopmentLiveCli(
  args: readonly string[],
  io: Io = {
    stdout: (value) => process.stdout.write(`${value}\n`),
    stderr: (value) => process.stderr.write(`${value}\n`),
    now: () => new Date(),
  },
  execute?: Execute,
): Promise<number> {
  try {
    const command = args[0];
    if (command === "status") {
      if (args.length !== 1) throw new Error("LC4-DEV status accepts no flags");
      io.stdout(JSON.stringify({
        protocol_id: "HACC-LC4-DEV-v1",
        episodes: 6,
        opportunities_per_episode: 60,
        total_opportunities: 360,
        hard_ceiling_micro_usd: LC4_DEV_LIVE_HARD_CEILING_MICRO_USD,
        timeout_policy: LC4_DEV_LIVE_TIMEOUTS,
        adapter_boundary: LC4_DEV_ADAPTER_BOUNDARY,
        execution_ready: false,
        executable_pipeline_blockers: LC4_DEV_EXECUTABLE_PIPELINE_BLOCKERS,
      }));
      return 0;
    }
    const parsed = flags(args.slice(1));
    if (command === "prepare") {
      exact(parsed, ["--input"]);
      const input = await json<Parameters<typeof createLc4DevLivePrepareArtifact>[0]>(parsed["--input"]!);
      io.stdout(JSON.stringify(createLc4DevLivePrepareArtifact(input)));
      return 0;
    }
    if (command === "preflight") {
      exact(parsed, ["--input"]);
      const input = await json<Omit<Parameters<typeof createLc4DevLivePreflightArtifact>[0], "checked_at"> & { checked_at?: string }>(parsed["--input"]!);
      io.stdout(JSON.stringify(createLc4DevLivePreflightArtifact({ ...input, checked_at: input.checked_at ?? io.now().toISOString() })));
      return 0;
    }
    if (command === "run") {
      exact(parsed, ["--prepare", "--preflight"]);
      const [prepare, preflight] = await Promise.all([
        json<Lc4DevLivePrepareArtifact>(parsed["--prepare"]!),
        json<Lc4DevLivePreflightArtifact>(parsed["--preflight"]!),
      ]);
      if (!execute) throw new Error("LC4-DEV run requires the DEV-authorized provider adapter plus audio, control, retention, listener, and ledger dependencies");
      io.stdout(JSON.stringify(await execute(prepare, preflight)));
      return 0;
    }
    if (command === "report") {
      exact(parsed, ["--run"]);
      io.stdout(JSON.stringify(createLc4DevLiveReportArtifact(await json<Lc4DevLiveRunArtifact>(parsed["--run"]!))));
      return 0;
    }
    throw new Error("usage: lc4-development-live <status|prepare|preflight|run|report>");
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : "LC4-DEV CLI failed");
    return 1;
  }
}
