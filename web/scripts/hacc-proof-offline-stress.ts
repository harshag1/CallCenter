import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertOfflineStressPassed,
  runOfflineDeterministicStress,
  serializeOfflineStressReport,
} from "../lib/benchmark/v2/stress";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceFiles = Object.freeze([
  "lib/runtime-control/turn-contract.ts",
  "lib/conversation-program/schema.ts",
  "lib/conversation-program/reducer.ts",
  "lib/governed-effect-runtime/types.ts",
  "lib/governed-effect-runtime/coordinator.ts",
  "lib/audibility-v2/ledger.ts",
  "lib/evidence-v2/evidence-tap.ts",
  "lib/evidence-v2/replay.ts",
  "lib/benchmark/v2/stress/types.ts",
  "lib/benchmark/v2/stress/canonical.ts",
  "lib/benchmark/v2/stress/effect-store.ts",
  "lib/benchmark/v2/stress/runner.ts",
  "scripts/hacc-proof-offline-stress.ts",
]);

type CliOptions = {
  proposalCount: number;
  raceScheduleCount: number;
  replayScheduleCount: number;
  seedStart: number;
  output: string | null;
};

function positiveInteger(raw: string | undefined, flag: string, allowZero = false): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${flag} requires a ${allowZero ? "non-negative" : "positive"} safe integer`);
  }
  return value;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    proposalCount: 100_000,
    raceScheduleCount: 10_000,
    replayScheduleCount: 10_000,
    seedStart: 1,
    output: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--ci") {
      options.proposalCount = 400;
      options.raceScheduleCount = 100;
      options.replayScheduleCount = 100;
    } else if (flag === "--proposals") {
      options.proposalCount = positiveInteger(argv[++index], flag);
    } else if (flag === "--races") {
      options.raceScheduleCount = positiveInteger(argv[++index], flag);
    } else if (flag === "--replays") {
      options.replayScheduleCount = positiveInteger(argv[++index], flag);
    } else if (flag === "--seed-start") {
      options.seedStart = positiveInteger(argv[++index], flag, true);
    } else if (flag === "--output") {
      options.output = argv[++index] ?? null;
      if (!options.output) throw new Error("--output requires a path");
    } else if (flag === "--help") {
      process.stdout.write([
        "Usage: tsx scripts/hacc-proof-offline-stress.ts [options]",
        "",
        "  --ci              run the bounded CI profile (400/100/100)",
        "  --proposals N     governed proposals (default 100000)",
        "  --races N         effect race schedules (default 10000)",
        "  --replays N       correction/reconnect/replay schedules (default 10000)",
        "  --seed-start N    first deterministic seed (default 1)",
        "  --output PATH     also write the canonical report to PATH",
        "",
      ].join("\n"));
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  return options;
}

async function sourceDigest(): Promise<string> {
  const hash = createHash("sha256");
  hash.update("hacc/offline-stress/source-bundle/v1\n", "utf8");
  for (const relativePath of sourceFiles) {
    hash.update(`${relativePath}\0`, "utf8");
    hash.update(await readFile(resolve(webRoot, relativePath)));
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const report = await runOfflineDeterministicStress({
    proposalCount: options.proposalCount,
    raceScheduleCount: options.raceScheduleCount,
    replayScheduleCount: options.replayScheduleCount,
    seedStart: options.seedStart,
    sourceSha256: await sourceDigest(),
  });
  assertOfflineStressPassed(report);
  const serialized = serializeOfflineStressReport(report);
  if (options.output) {
    const output = resolve(process.cwd(), options.output);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, serialized, { encoding: "utf8", mode: 0o644 });
  }
  process.stdout.write(serialized);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
