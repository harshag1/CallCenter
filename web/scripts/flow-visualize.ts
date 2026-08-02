#!/usr/bin/env node

import { constants } from "node:fs";
import { access, lstat, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { analyzeFlowV2Import } from "../lib/flow-package";
import { inspectFlow } from "../lib/flow-inspector";
import { renderFlowVisualizationHtml } from "../lib/flow-visualization";

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

function usage(): string {
  return "usage: npm run flow:visualize -- --flow FLOW.json --out NEW.html";
}

function options(argv: readonly string[]): Readonly<{ flow: string; out: string }> {
  let flow: string | null = null;
  let out: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--flow" && argument !== "--out") throw new Error(`unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires one path`);
    if (argument === "--flow") {
      if (flow) throw new Error("--flow may appear only once");
      flow = resolve(value);
    } else {
      if (out) throw new Error("--out may appear only once");
      out = resolve(value);
    }
    index += 1;
  }
  if (!flow || !out) throw new Error("--flow and --out are required");
  if (!out.toLowerCase().endsWith(".html")) throw new Error("--out must end in .html");
  return Object.freeze({ flow, out });
}

async function readJson(path: string): Promise<unknown> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_SOURCE_BYTES) {
    throw new Error(`flow must be a regular non-symlink JSON file no larger than ${MAX_SOURCE_BYTES} bytes`);
  }
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function writeExclusive(path: string, contents: string): Promise<void> {
  try {
    await access(path, constants.F_OK);
    throw new Error(`refusing to overwrite existing file: ${path}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("refusing to overwrite")) throw error;
  }
  await writeFile(path, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

async function main(): Promise<void> {
  const parsed = options(process.argv.slice(2));
  const plan = analyzeFlowV2Import(await readJson(parsed.flow));
  if (!plan.valid || !plan.flow) {
    process.stdout.write(`${JSON.stringify({ created: false, diagnostics: plan.diagnostics }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  // Visualization is structural review, not runtime admission. A catalog is deliberately
  // unnecessary here; the output labels referenced tools without claiming they exist.
  const flow = plan.flow;
  const summary = inspectFlow(flow);
  await writeExclusive(parsed.out, renderFlowVisualizationHtml(flow, basename(parsed.flow)));
  process.stdout.write(`${JSON.stringify({
    created: parsed.out,
    flow_sha256: plan.flowSha256,
    nodes: summary.nodeCount,
    steps: summary.stepCount,
    depth: summary.maxStepDepth,
    checkpoints: summary.checkpointCount,
    provider_calls: 0,
    database_writes: 0,
    expected_spend_usd: 0,
  })}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${usage()}\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
