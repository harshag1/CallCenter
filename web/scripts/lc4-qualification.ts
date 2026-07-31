import { runLc4QualificationV3Cli } from "../lib/benchmark/lc4-qualification-v3-runner";

void runLc4QualificationV3Cli(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
