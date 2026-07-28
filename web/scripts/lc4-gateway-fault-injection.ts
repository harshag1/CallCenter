import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../lib/benchmark/artifacts";
import {
  renderLc4GatewayFaultInjectionMarkdown,
  runLc4GatewayFaultInjectionBenchmark,
} from "../lib/benchmark/lc4-gateway-fault-injection";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(scriptDirectory, "..", "..");
const evidenceDirectory = join(
  repositoryRoot,
  "benchmarks",
  "voice-long-horizon",
  "evidence",
);
const jsonPath = join(
  evidenceDirectory,
  "HACC_LC4_GATEWAY_FAULT_INJECTION.json",
);
const markdownPath = join(
  evidenceDirectory,
  "HACC_LC4_GATEWAY_FAULT_INJECTION.md",
);

async function main(): Promise<void> {
  const artifact = await runLc4GatewayFaultInjectionBenchmark();
  const json = `${canonicalJson(artifact)}\n`;
  const markdown = renderLc4GatewayFaultInjectionMarkdown(artifact);
  if (process.argv.includes("--check")) {
    const [actualJson, actualMarkdown] = await Promise.all([
      readFile(jsonPath, "utf8"),
      readFile(markdownPath, "utf8"),
    ]);
    if (actualJson !== json || actualMarkdown !== markdown) {
      throw new Error(
        "checked-in LC4 gateway fault-injection evidence is stale",
      );
    }
    process.stdout.write(
      `verified ${artifact.artifact_sha256} (${artifact.summary.scenarios} scenarios)\n`,
    );
    return;
  }
  await Promise.all([
    writeFile(jsonPath, json, "utf8"),
    writeFile(markdownPath, markdown, "utf8"),
  ]);
  process.stdout.write(
    `wrote ${artifact.artifact_sha256} (${artifact.summary.scenarios} scenarios)\n`,
  );
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
