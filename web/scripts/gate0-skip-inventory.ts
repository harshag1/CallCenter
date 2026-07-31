#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HASH_DOMAIN = "harshas-amazing-call-center/gate0-skip-source-manifest/v1";
const SCOPE = Object.freeze([
  "web/**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs}",
  "web/vitest.config.ts",
  "web/package.json",
] as const);
const POLICY = Object.freeze({
  unexpected_skip: "fail",
  known_conditional_skip: "must_run_for_gate0",
  zero_failures_with_skips: "insufficient",
  public_ci_required_disposition: "must_run",
  environment_qualified_disposition: "release_receipt_required_for_lc4_publication",
  environment_qualified_receipt_command:
    "npm run benchmark:lc4:asr-environment:receipt -- --out ABSOLUTE_PATH",
} as const);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "../..");
const WEB_ROOT = resolve(REPOSITORY_ROOT, "web");
const INVENTORY_PATH = resolve(
  REPOSITORY_ROOT,
  "benchmarks/voice-long-horizon/GATE0_SKIP_INVENTORY.json",
);
const SELF_TEST_PATH = "web/lib/benchmark/__tests__/gate0-skip-inventory.test.ts";

type ReasonCategory =
  | "missing_postgresql_integration_environment"
  | "missing_postgresql_admin_integration_environment"
  | "missing_local_asr_integration_environment";

type InventoryEntry = Readonly<{
  path: string;
  content_sha256: string;
  test_count: number;
  condition: string;
  reason_category: ReasonCategory;
  gate0_disposition: "must_run" | "environment_qualified_release_receipt";
}>;

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function repositoryRelative(path: string): string {
  return relative(REPOSITORY_ROOT, path).split(sep).join("/");
}

function testSourceFiles(root: string): readonly string[] {
  const paths: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (["node_modules", ".next", "coverage", "dist"].includes(entry.name)) continue;
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (/\.(?:test|spec)\.(?:c|m)?(?:j|t)sx?$/.test(entry.name)) paths.push(absolute);
    }
  };
  visit(root);
  return Object.freeze(paths.sort());
}

function relevantSourceFiles(): readonly string[] {
  return Object.freeze([
    ...testSourceFiles(WEB_ROOT),
    resolve(WEB_ROOT, "vitest.config.ts"),
    resolve(WEB_ROOT, "package.json"),
  ].sort());
}

function discoveredConditionalConstructs(paths: readonly string[]) {
  return paths.flatMap((path) => {
    const source = readFileSync(path, "utf8");
    const matches = source.match(/\b(?:describe|it|test)\.(?:skip|todo|skipIf|runIf)\b/g) ?? [];
    return matches.map((construct) => ({
      path: repositoryRelative(path),
      construct,
    }));
  });
}

function reasonCategory(environmentVariable: string): ReasonCategory {
  if (environmentVariable === "LC4_REAL_ASR_INTEGRATION") {
    return "missing_local_asr_integration_environment";
  }
  if (environmentVariable === "SECURITY_MIGRATION_INTEGRATION_DATABASE_URL") {
    return "missing_postgresql_admin_integration_environment";
  }
  if (
    [
      "AUTH_SECURITY_INTEGRATION_DATABASE_URL",
      "CONVERSATION_INTEGRATION_DATABASE_URL",
      "CREDENTIAL_VAULT_INTEGRATION_DATABASE_URL",
      "FLOW_INTEGRATION_DATABASE_URL",
    ].includes(environmentVariable)
  ) {
    return "missing_postgresql_integration_environment";
  }
  throw new Error(`unclassified Gate 0 conditional environment: ${environmentVariable}`);
}

function inventoryEntry(path: string, construct: string): InventoryEntry {
  if (construct !== "describe.runIf") {
    throw new Error(`unexpected conditional-test construct ${construct} in ${path}`);
  }
  const source = readFileSync(resolve(REPOSITORY_ROOT, path), "utf8");
  const exactCondition = source.match(
    /const\s+([A-Za-z_$][\w$]*)\s*=\s*process\.env\.([A-Z0-9_]+);[\s\S]*?describe\.runIf\(Boolean\(\1\)\)/,
  );
  if (!exactCondition) {
    throw new Error(`unsupported Gate 0 conditional-test shape in ${path}`);
  }
  const environmentVariable = exactCondition[2];
  const reason = reasonCategory(environmentVariable);
  const testCount = (source.match(/(?:^|\n)\s*(?:it|test)\s*\(/g) ?? []).length;
  if (testCount < 1) throw new Error(`conditional suite has no tests: ${path}`);
  return Object.freeze({
    path,
    content_sha256: sha256(source),
    test_count: testCount,
    condition: `${environmentVariable} is absent`,
    reason_category: reason,
    gate0_disposition: reason === "missing_local_asr_integration_environment"
      ? "environment_qualified_release_receipt"
      : "must_run",
  });
}

function generatedInventory(): string {
  const testSources = testSourceFiles(WEB_ROOT);
  const relevantSources = relevantSourceFiles();
  const skips = discoveredConditionalConstructs(relevantSources)
    .filter(({ path }) => path !== SELF_TEST_PATH);
  const entries = Object.freeze(skips.map(({ path, construct }) => inventoryEntry(path, construct)));
  const publicEntries = entries.filter(({ gate0_disposition }) => gate0_disposition === "must_run");
  const environmentEntries = entries.filter(
    ({ gate0_disposition }) => gate0_disposition === "environment_qualified_release_receipt",
  );
  const manifestBody = {
    scope: SCOPE,
    test_source_paths: testSources.map(repositoryRelative),
    conditional_source_files: [...new Set(skips.map(({ path }) => path))].map((path) => ({
      path,
      content_sha256: sha256(readFileSync(resolve(REPOSITORY_ROOT, path))),
    })),
    runner_config_files: [
      resolve(WEB_ROOT, "vitest.config.ts"),
      resolve(WEB_ROOT, "package.json"),
    ].map((path) => ({
      path: repositoryRelative(path),
      content_sha256: sha256(readFileSync(path)),
    })),
    discovered_conditional_constructs: skips,
  };
  const inventory = {
    schema_version: 1,
    artifact_type: "gate0_test_skip_inventory",
    source_binding: {
      kind: "canonical_relevant_source_manifest",
      hash_domain: HASH_DOMAIN,
      source_manifest_sha256: sha256(`${HASH_DOMAIN}\n${JSON.stringify(manifestBody)}`),
      source_manifest_file_count: relevantSources.length,
      manifest_semantics: "all_test_paths_plus_conditional_contents_and_runner_config",
      scope: SCOPE,
      commit_binding: "external_gate0_proof_packet",
    },
    policy: POLICY,
    entries,
    total_skipped_suites_when_unconfigured: entries.length,
    total_skipped_tests_when_unconfigured: entries.reduce((sum, entry) => sum + entry.test_count, 0),
    public_ci_required_suites: publicEntries.length,
    public_ci_required_tests: publicEntries.reduce((sum, entry) => sum + entry.test_count, 0),
    environment_qualified_suites: environmentEntries.length,
    environment_qualified_tests: environmentEntries.reduce(
      (sum, entry) => sum + entry.test_count,
      0,
    ),
  };
  return `${JSON.stringify(inventory, null, 2)}\n`;
}

function main(argv: readonly string[]): void {
  if (argv.length !== 1 || !["--write", "--check"].includes(argv[0])) {
    throw new Error("usage: gate0-skip-inventory (--write|--check)");
  }
  const generated = generatedInventory();
  if (argv[0] === "--write") {
    const current = readFileSync(INVENTORY_PATH, "utf8");
    if (current !== generated) writeFileSync(INVENTORY_PATH, generated, "utf8");
    process.stdout.write(
      current === generated
        ? "Gate 0 skip inventory is already current.\n"
        : "Refreshed Gate 0 skip inventory.\n",
    );
    return;
  }
  const current = readFileSync(INVENTORY_PATH, "utf8");
  if (current !== generated) {
    process.stderr.write(
      "Gate 0 skip inventory is stale; run npm run benchmark:gate0:inventory:refresh.\n",
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write("Gate 0 skip inventory is current.\n");
}

main(process.argv.slice(2));
