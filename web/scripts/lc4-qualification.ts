import { runLc4QualificationCli } from "../lib/benchmark/lc4-qualification-runner";

void runLc4QualificationCli(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
