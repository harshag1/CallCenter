import { runLc4DevPublicResultCli } from "../lib/benchmark/lc4-development-public-results-cli";

process.exitCode = await runLc4DevPublicResultCli(process.argv.slice(2));

