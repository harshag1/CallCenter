import { runLc4DevPublicResultCli } from "../lib/benchmark/lc4-development-public-results-cli";

void runLc4DevPublicResultCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
