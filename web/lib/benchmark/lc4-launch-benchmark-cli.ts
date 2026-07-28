import { canonicalJson } from "./artifacts";
import {
  LC4_LAUNCH_BENCHMARK_FILENAMES,
  publishLc4LaunchBenchmark,
  verifyPublishedLc4LaunchBenchmark,
} from "./lc4-launch-benchmark";

type Io = Readonly<{ stdout(value: string): void; stderr(value: string): void }>;

function flags(args: readonly string[]): Readonly<Record<string, string>> {
  if (args.length % 2 !== 0) throw new Error("LC4 launch benchmark CLI requires --flag value pairs");
  const output: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!;
    const value = args[index + 1]!;
    if (!key.startsWith("--") || value.startsWith("--") || output[key] !== undefined) {
      throw new Error("LC4 launch benchmark CLI flags are malformed or duplicated");
    }
    output[key] = value;
  }
  return Object.freeze(output);
}

function exact(actual: Readonly<Record<string, string>>, expected: readonly string[]): void {
  if (canonicalJson(Object.keys(actual).sort()) !== canonicalJson([...expected].sort())) {
    throw new Error(`LC4 launch benchmark CLI requires exactly: ${[...expected].sort().join(", ")}`);
  }
}

export async function runLc4LaunchBenchmarkCli(
  args: readonly string[],
  io: Io = {
    stdout: (value) => process.stdout.write(`${value}\n`),
    stderr: (value) => process.stderr.write(`${value}\n`),
  },
): Promise<number> {
  try {
    const command = args[0];
    const parsed = flags(args.slice(1));
    if (command === "publish") {
      exact(parsed, ["--evidence-root", "--output-root"]);
      const artifact = await publishLc4LaunchBenchmark({
        evidence_root: parsed["--evidence-root"]!,
        output_root: parsed["--output-root"]!,
      });
      io.stdout(canonicalJson({
        valid: true,
        action: "published",
        benchmark_sha256: artifact.benchmark_sha256,
        efficacy_claim_eligible: artifact.efficacy_claim_eligible,
        files: LC4_LAUNCH_BENCHMARK_FILENAMES,
        provider_calls_made: false,
      }));
      return 0;
    }
    if (command === "verify") {
      exact(parsed, ["--evidence-root", "--public-json", "--public-markdown"]);
      const artifact = await verifyPublishedLc4LaunchBenchmark({
        evidence_root: parsed["--evidence-root"]!,
        public_json: parsed["--public-json"]!,
        public_markdown: parsed["--public-markdown"]!,
      });
      io.stdout(canonicalJson({
        valid: true,
        action: "verified",
        benchmark_sha256: artifact.benchmark_sha256,
        efficacy_claim_eligible: artifact.efficacy_claim_eligible,
        provider_calls_made: false,
      }));
      return 0;
    }
    throw new Error("usage: lc4-launch-benchmark <publish|verify>");
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : "LC4 launch benchmark CLI failed");
    return 1;
  }
}
