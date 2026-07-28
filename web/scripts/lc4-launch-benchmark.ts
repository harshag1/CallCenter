import { runLc4LaunchBenchmarkCli } from "../lib/benchmark/lc4-launch-benchmark-cli";

process.exitCode = await runLc4LaunchBenchmarkCli(process.argv.slice(2));
