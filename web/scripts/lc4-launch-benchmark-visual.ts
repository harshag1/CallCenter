import { runLc4LaunchBenchmarkVisualCli } from "../lib/benchmark/lc4-launch-benchmark-visual-cli";

process.exitCode = await runLc4LaunchBenchmarkVisualCli(process.argv.slice(2));
