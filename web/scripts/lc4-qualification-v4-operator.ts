import { runLc4QualificationV4OperatorCli } from "../lib/benchmark/lc4-qualification-v4-operator-cli";

void runLc4QualificationV4OperatorCli(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
