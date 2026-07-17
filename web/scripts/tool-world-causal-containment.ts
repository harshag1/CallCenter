#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runToolWorldCausalContainment } from "../lib/benchmark/tool-world-causal-containment";
import {
  TOOL_WORLD_CAUSAL_ARTIFACT_PATH,
  TOOL_WORLD_CAUSAL_PROVENANCE_PATH,
  createToolWorldCausalProvenanceManifest,
  verifyToolWorldCausalProvenanceManifest,
} from "../lib/benchmark/tool-world-causal-provenance";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ARTIFACT_PATH = resolve(REPO_ROOT, TOOL_WORLD_CAUSAL_ARTIFACT_PATH);
const PROVENANCE_PATH = resolve(REPO_ROOT, TOOL_WORLD_CAUSAL_PROVENANCE_PATH);

function integerOption(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const raw = process.argv[index + 1];
  if (!raw || !/^\d+$/.test(raw)) throw new Error(`--${name} requires a non-negative integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`--${name} exceeds safe integer precision`);
  return value;
}

if (process.argv.includes("--help")) {
  process.stdout.write([
    "Usage: npx tsx scripts/tool-world-causal-containment.ts [options]",
    "",
    "Options:",
    "  --seed-start N       First deterministic seed (default 7301)",
    "  --seeds-per-case N   Seeds in each of five schedule families (default 32)",
    "  --write              Replace the checked artifact and provenance manifest (canonical range only)",
    "  --check              Verify generation, artifact bytes, source bytes, and Git base provenance",
    "  --help               Show this help",
    "",
    "The canonical JSON artifact is written to stdout; no provider calls are made.",
    "",
  ].join("\n"));
} else {
  if (process.argv.includes("--write") && process.argv.includes("--check")) {
    throw new Error("--write and --check are mutually exclusive");
  }
  const report = runToolWorldCausalContainment({
    seed_start: integerOption("seed-start", 7_301),
    seeds_per_case: integerOption("seeds-per-case", 32),
  });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (process.argv.includes("--write") || process.argv.includes("--check")) {
    if (report.design_status !== "fixed-development-design") {
      throw new Error("--write and --check require the canonical seed range");
    }
  }
  if (process.argv.includes("--write")) {
    writeFileSync(ARTIFACT_PATH, serialized, "utf8");
    const provenance = createToolWorldCausalProvenanceManifest(REPO_ROOT);
    writeFileSync(PROVENANCE_PATH, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
    process.stdout.write(`wrote ${ARTIFACT_PATH}\nwrote ${PROVENANCE_PATH}\n`);
  } else if (process.argv.includes("--check")) {
    if (readFileSync(ARTIFACT_PATH, "utf8") !== serialized) {
      throw new Error(`checked artifact differs from fresh generation: ${ARTIFACT_PATH}`);
    }
    const provenance = JSON.parse(readFileSync(PROVENANCE_PATH, "utf8"));
    const verification = verifyToolWorldCausalProvenanceManifest(REPO_ROOT, provenance);
    if (!verification.valid) {
      throw new Error(`causal provenance verification failed: ${verification.errors.join("; ")}`);
    }
    process.stdout.write(`verified ${ARTIFACT_PATH}\nverified ${PROVENANCE_PATH}\n`);
  } else {
    process.stdout.write(serialized);
  }
}
