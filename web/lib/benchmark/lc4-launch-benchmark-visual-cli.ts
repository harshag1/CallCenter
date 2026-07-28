import { canonicalJson } from "./artifacts";
import { publishLc4LaunchBenchmarkVisual } from "./lc4-launch-benchmark-visual";

type Io = Readonly<{ stdout(value: string): void; stderr(value: string): void }>;

function flags(args: readonly string[]): Readonly<Record<string, string>> {
  if (args.length % 2 !== 0) {
    throw new Error("LC4 launch benchmark visual CLI requires --flag value pairs");
  }
  const parsed: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!;
    const value = args[index + 1]!;
    if (!key.startsWith("--") || value.startsWith("--") || parsed[key] !== undefined) {
      throw new Error("LC4 launch benchmark visual CLI flags are malformed or duplicated");
    }
    parsed[key] = value;
  }
  return Object.freeze(parsed);
}

export async function runLc4LaunchBenchmarkVisualCli(
  args: readonly string[],
  io: Io = {
    stdout: (value) => process.stdout.write(`${value}\n`),
    stderr: (value) => process.stderr.write(`${value}\n`),
  },
): Promise<number> {
  try {
    if (args[0] !== "publish") {
      throw new Error("usage: lc4-launch-benchmark-visual publish --public-json /absolute/path --output-root /absolute/path");
    }
    const parsed = flags(args.slice(1));
    const expected = ["--output-root", "--public-json"];
    if (canonicalJson(Object.keys(parsed).sort()) !== canonicalJson(expected)) {
      throw new Error(`LC4 launch benchmark visual CLI requires exactly: ${expected.join(", ")}`);
    }
    const result = await publishLc4LaunchBenchmarkVisual({
      public_json: parsed["--public-json"]!,
      output_root: parsed["--output-root"]!,
    });
    io.stdout(canonicalJson({
      valid: true,
      action: "published",
      benchmark_sha256: result.benchmark_sha256,
      files: result.files,
      provider_calls_made: false,
    }));
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : "LC4 launch benchmark visual CLI failed");
    return 1;
  }
}
