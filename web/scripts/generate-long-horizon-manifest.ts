import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { renderLongHorizonManifest } from "../lib/benchmark/long-horizon-manifest";

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const target = resolve(here, "../../benchmarks/voice-long-horizon/scenarios/LONG_HORIZON_MANIFEST.md");
  const rendered = renderLongHorizonManifest();

  if (process.argv.includes("--write")) {
    await writeFile(target, rendered, "utf8");
    process.stdout.write(`updated ${target}\n`);
  } else if (process.argv.includes("--check")) {
    const current = await readFile(target, "utf8");
    if (current !== rendered) {
      process.stderr.write("long-horizon manifest is stale; run this script with --write\n");
      process.exitCode = 1;
    } else {
      process.stdout.write("long-horizon manifest is current\n");
    }
  } else {
    process.stdout.write(rendered);
  }
}

void main();
