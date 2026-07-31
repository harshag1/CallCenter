import { runLc4QualificationV3OperatorCli } from "../lib/benchmark/lc4-qualification-v3-operator-cli";

void runLc4QualificationV3OperatorCli(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
