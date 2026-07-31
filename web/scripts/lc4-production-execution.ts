import { runLc4ProductionExecutionCli } from "../lib/benchmark/lc4-production-execution-cli";

void runLc4ProductionExecutionCli(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
