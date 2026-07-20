#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { link, mkdir, open, unlink, writeFile } from "node:fs/promises";
import { runActiveCatalogEfficiencyBenchmark } from "../lib/benchmark/active-catalog-efficiency";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
  return value;
}

async function publishNoClobber(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.partial`;
  try {
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const descriptor = await open(temporary, "r");
    try {
      await descriptor.sync();
    } finally {
      await descriptor.close();
    }
    await link(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write([
      "Usage: npm run benchmark:active-catalog -- [options]",
      "",
      "Options:",
      "  --out FILE  No-clobber full JSON artifact path",
      "  --help      Show this help",
      "",
    ].join("\n"));
    return;
  }
  const report = runActiveCatalogEfficiencyBenchmark();
  const output = option("out");
  if (output) {
    await publishNoClobber(resolve(output), `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify({
    ...(output ? { output: resolve(output) } : {}),
    result_hash: report.result_hash,
    evidence_hash: report.evidence_hash,
    source_manifest_sha256: report.provenance.source_manifest_sha256,
    build_manifest_sha256: report.provenance.build_manifest_sha256,
    toolchain_manifest_sha256: report.provenance.toolchain_manifest_sha256,
    corpus_raw_source_sha256: report.corpus.raw_source_file_sha256,
    corpus_canonical_json_sha256: report.corpus.canonical_json_sha256,
    raw_full_tool_count: report.raw_full_logical_entry_array_reference.tool_count,
    raw_full_logical_entry_array_bytes:
      report.raw_full_logical_entry_array_reference.canonical_json_array_bytes,
    raw_full_t4: report.raw_full_logical_entry_array_reference.estimated_t4_at_4_bytes_per_token,
    active_business_tool_count: report.progressive_state_census.active_business_tool_count,
    active_business_entry_array_bytes: report.progressive_state_census.active_business_entry_array_bytes,
    active_business_entry_array_t4: report.progressive_state_census.active_business_entry_array_t4,
    active_business_entry_array_reduction_ppm:
      report.progressive_state_census.active_business_entry_array_reduction_ppm,
    active_full_catalog_json_bytes: report.progressive_state_census.active_full_catalog_json_bytes,
    active_provider_instruction_block_bytes:
      report.progressive_state_census.active_provider_instruction_block_bytes,
    peak_total_logical_tools: report.progressive_state_census.peak_total_logical_tool_count,
    catalog_exposed_tools:
      report.catalog_exposure_and_non_disclosure.target_tools_catalog_exposed_in_frozen_census,
    private_leak_hits: report.catalog_exposure_and_non_disclosure.public_forbidden_private_key_hits +
      report.catalog_exposure_and_non_disclosure.public_private_sentinel_hits,
    claim_scope: report.claim_scope,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
