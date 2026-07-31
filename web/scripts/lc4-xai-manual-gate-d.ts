import {
  runLc4XaiManualGateDOperatorCli,
} from "../lib/benchmark/lc4-xai-manual-gate-d-operator-cli";

void runLc4XaiManualGateDOperatorCli(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
