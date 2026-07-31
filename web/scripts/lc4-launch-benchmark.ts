import { runLc4LaunchBenchmarkCli } from "../lib/benchmark/lc4-launch-benchmark-cli";

void runLc4LaunchBenchmarkCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
