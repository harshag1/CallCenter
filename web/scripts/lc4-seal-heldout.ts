import { runLc4SealCli } from "../lib/benchmark/lc4-heldout-seal-cli";

void runLc4SealCli(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
