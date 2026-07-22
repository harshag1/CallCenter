import { runLc4QualificationCli } from "../lib/benchmark/lc4-qualification-runner";

process.exitCode = await runLc4QualificationCli(process.argv.slice(2));
