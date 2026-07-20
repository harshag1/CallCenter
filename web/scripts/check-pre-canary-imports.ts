#!/usr/bin/env node

import { resolve } from "node:path";
import { build } from "esbuild";
import { canonicalJson, sha256Hex } from "../lib/benchmark/artifacts";

const cwd = resolve(process.cwd());
const entry = "scripts/pre-canary-proof.ts";

async function main(): Promise<void> {
  const result = await build({
    absWorkingDir: cwd,
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    metafile: true,
    write: false,
    logLevel: "silent",
  });
  if (!result.metafile) throw new Error("esbuild did not return a pre-canary import graph");
  const runtimeInputs = Object.keys(result.metafile.inputs).sort();
  const forbiddenRuntimeInputs = runtimeInputs.filter((path) => (
    /(?:^|\/)lib\/benchmark\/paid-runner\.ts$/.test(path)
    || /(?:^|\/)scripts\/voice-benchmark\.ts$/.test(path)
    || /(?:^|\/)lib\/realtime\/client\/(?:openai-compatible|gemini-live)\.ts$/.test(path)
    || /(?:^|\/)lib\/realtime\/providers\//.test(path)
  ));
  const externalSocketImports = Object.values(result.metafile.inputs)
    .flatMap((input) => input.imports)
    .filter((dependency) => dependency.external && /^(?:ws|websocket|@google\/genai|openai)(?:\/|$)/i.test(dependency.path))
    .map((dependency) => dependency.path)
    .sort();
  const report = Object.freeze({
    schema_version: 1,
    entry,
    runtime_input_count: runtimeInputs.length,
    runtime_import_closure_sha256: sha256Hex(canonicalJson(runtimeInputs)),
    provider_client_construction_reachable: forbiddenRuntimeInputs.length > 0,
    external_socket_imports: Object.freeze(externalSocketImports),
    forbidden_runtime_inputs: Object.freeze(forbiddenRuntimeInputs),
  });
  process.stdout.write(`${canonicalJson(report)}\n`);
  if (forbiddenRuntimeInputs.length > 0 || externalSocketImports.length > 0) process.exitCode = 1;
}

void main();
