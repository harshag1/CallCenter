import { runLc4DevelopmentLiveCli } from "../lib/benchmark/lc4-development-live-cli";

void runLc4DevelopmentLiveCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
