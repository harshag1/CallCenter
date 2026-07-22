import { runLc4DevelopmentAudioCli } from "../lib/benchmark/lc4-development-audio-cli";

process.exitCode = await runLc4DevelopmentAudioCli(process.argv.slice(2));
