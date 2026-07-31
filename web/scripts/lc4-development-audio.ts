import { runLc4DevelopmentAudioCli } from "../lib/benchmark/lc4-development-audio-cli";

void runLc4DevelopmentAudioCli(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
