import { runLc4DevelopmentOperatorCli } from "../lib/benchmark/lc4-development-operator-cli";

void runLc4DevelopmentOperatorCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
