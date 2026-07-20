import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type SkipInventoryEntry = Readonly<{
  path: string;
  content_sha256: string;
  test_count: number;
  condition: string;
  reason_category:
    | "missing_postgresql_integration_environment"
    | "missing_postgresql_admin_integration_environment";
  gate0_disposition: "must_run";
}>;

type SkipInventory = Readonly<{
  schema_version: 1;
  artifact_type: "gate0_test_skip_inventory";
  source_binding: Readonly<{
    kind: "canonical_relevant_source_manifest";
    hash_domain: "harshas-amazing-call-center/gate0-skip-source-manifest/v1";
    source_manifest_sha256: string;
    source_manifest_file_count: number;
    manifest_semantics: "all_test_paths_plus_conditional_contents_and_runner_config";
    scope: readonly [
      "web/**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs}",
      "web/vitest.config.ts",
      "web/package.json"
    ];
    commit_binding: "external_gate0_proof_packet";
  }>;
  policy: Readonly<{
    unexpected_skip: "fail";
    known_conditional_skip: "must_run_for_gate0";
    zero_failures_with_skips: "insufficient";
  }>;
  entries: readonly SkipInventoryEntry[];
  total_skipped_suites_when_unconfigured: number;
  total_skipped_tests_when_unconfigured: number;
}>;

const repositoryRoot = resolve(process.cwd(), "..");
const inventoryPath = resolve(
  repositoryRoot,
  "benchmarks/voice-long-horizon/GATE0_SKIP_INVENTORY.json"
);

function testSourceFiles(root: string): readonly string[] {
  const paths: string[] = [];
  const visit = (directory: string) => {
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
    ...testSourceFiles(resolve(repositoryRoot, "web")),
    resolve(repositoryRoot, "web/vitest.config.ts"),
    resolve(repositoryRoot, "web/package.json"),
  ].sort());
}

function discoveredConditionalConstructs(paths: readonly string[]) {
  return paths.flatMap((path) => {
    const source = readFileSync(path, "utf8");
    const matches = source.match(/\b(?:describe|it|test)\.(?:skip|todo|skipIf|runIf)\b/g) ?? [];
    return matches.map((construct) => ({
      path: path.slice(repositoryRoot.length + 1),
      construct,
    }));
  });
}

describe("Gate 0 conditional-test skip inventory", () => {
  it("is source-manifest bound and fails on any uninventoryed skip or todo", () => {
    const inventory = JSON.parse(readFileSync(inventoryPath, "utf8")) as SkipInventory;
    expect(inventory).toMatchObject({
      schema_version: 1,
      artifact_type: "gate0_test_skip_inventory",
      source_binding: {
        kind: "canonical_relevant_source_manifest",
        hash_domain: "harshas-amazing-call-center/gate0-skip-source-manifest/v1",
        manifest_semantics: "all_test_paths_plus_conditional_contents_and_runner_config",
        scope: [
          "web/**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs}",
          "web/vitest.config.ts",
          "web/package.json",
        ],
        commit_binding: "external_gate0_proof_packet",
      },
      policy: {
        unexpected_skip: "fail",
        known_conditional_skip: "must_run_for_gate0",
        zero_failures_with_skips: "insufficient",
      },
    });
    expect(inventory).not.toHaveProperty("source_commit");
    expect(inventory.source_binding.source_manifest_sha256).toMatch(/^[a-f0-9]{64}$/);

    const relevantSources = relevantSourceFiles();
    expect(relevantSources.map((path) => path.slice(repositoryRoot.length + 1)))
      .not.toContain("benchmarks/voice-long-horizon/GATE0_SKIP_INVENTORY.json");
    expect(inventory.source_binding.source_manifest_file_count).toBe(relevantSources.length);

    const skips = discoveredConditionalConstructs(relevantSources)
      .filter(({ path }) => !path.endsWith("/gate0-skip-inventory.test.ts"));
    expect(skips).toEqual(inventory.entries.map((entry) => ({
      path: entry.path,
      construct: "describe.runIf",
    })));

    let testTotal = 0;
    for (const entry of inventory.entries) {
      const source = readFileSync(resolve(repositoryRoot, entry.path), "utf8");
      expect(createHash("sha256").update(source).digest("hex")).toBe(entry.content_sha256);
      const environmentVariable = entry.condition.split(" ")[0];
      const exactCondition = source.match(
        /const\s+([A-Za-z_$][\w$]*)\s*=\s*process\.env\.([A-Z0-9_]+);[\s\S]*?describe\.runIf\(Boolean\(\1\)\)/
      );
      expect(exactCondition?.[2], entry.path).toBe(environmentVariable);
      expect(entry.gate0_disposition).toBe("must_run");
      const testCount = (source.match(/(?:^|\n)\s*(?:it|test)\s*\(/g) ?? []).length;
      expect(testCount, entry.path).toBe(entry.test_count);
      testTotal += testCount;
    }
    expect(inventory.entries).toHaveLength(inventory.total_skipped_suites_when_unconfigured);
    expect(testTotal).toBe(inventory.total_skipped_tests_when_unconfigured);

    const manifestBody = {
      scope: inventory.source_binding.scope,
      test_source_paths: testSourceFiles(resolve(repositoryRoot, "web"))
        .map((path) => path.slice(repositoryRoot.length + 1)),
      conditional_source_files: [...new Set(skips.map(({ path }) => path))].map((path) => ({
        path,
        content_sha256: createHash("sha256")
          .update(readFileSync(resolve(repositoryRoot, path)))
          .digest("hex"),
      })),
      runner_config_files: [
        resolve(repositoryRoot, "web/vitest.config.ts"),
        resolve(repositoryRoot, "web/package.json"),
      ].map((path) => ({
        path: path.slice(repositoryRoot.length + 1),
        content_sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      })),
      discovered_conditional_constructs: skips,
    };
    const manifestSha256 = createHash("sha256")
      .update(`${inventory.source_binding.hash_domain}\n`)
      .update(JSON.stringify(manifestBody))
      .digest("hex");
    expect(manifestSha256).toBe(inventory.source_binding.source_manifest_sha256);
  });

  it("leaves the containing clean-commit binding to the external Gate 0 proof", () => {
    const raw = readFileSync(inventoryPath, "utf8");
    const inventory = JSON.parse(raw) as SkipInventory;
    expect(raw).not.toContain('"source_commit"');
    expect(inventory.source_binding.commit_binding).toBe("external_gate0_proof_packet");
  });
});
