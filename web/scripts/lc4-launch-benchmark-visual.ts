import { runLc4LaunchBenchmarkVisualCli } from "../lib/benchmark/lc4-launch-benchmark-visual-cli";

void runLc4LaunchBenchmarkVisualCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
