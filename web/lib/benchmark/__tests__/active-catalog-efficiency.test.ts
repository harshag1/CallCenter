import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../artifacts";
import { runActiveCatalogEfficiencyBenchmark } from "../active-catalog-efficiency";

const EVIDENCE_HASH_DOMAIN = "harshas-amazing-call-center/active-catalog-efficiency-evidence/v1\n";
const TOOLCHAIN_MANIFEST_HASH_DOMAIN = "harshas-amazing-call-center/active-catalog-efficiency-toolchain/v1\n";
const REPORT = runActiveCatalogEfficiencyBenchmark();

describe("active capability catalog efficiency evidence", () => {
  it("freezes the portable 64-tool semantic result and exact source manifest", () => {
    const report = REPORT;

    expect(report.result_hash).toBe("8e3ec290e3fd2083ead8f8857ebbe41880accdc54fedad8cfd61c0000ae359d1");
    expect(report.provenance.source_manifest_sha256)
      .toBe("fd84bb08347983e660bc77f672901620b26e8748f62463354312a6359ba2918a");
    expect(report.provenance.build_manifest_sha256)
      .toBe("d7f59259e57b998806e4e34dd12800a43c250a768d1f4c2856be07ca0156b455");
    expect(report.provenance.toolchain_manifest_sha256)
      .toMatch(/^[a-f0-9]{64}$/);
    expect(report.corpus).toMatchObject({
      raw_source_file_bytes: 13_497,
      raw_source_file_sha256: "67f1153d90ab578916fb31ce6b543aa74d382374453a1718ab5675bc8ae1df1b",
      canonical_json_bytes: 11_932,
      canonical_json_sha256: "89452f09d62f3588e6b37acdd914aaa1c3b612c7ed89cb9b1a7ca3beeabc72c7",
      group_count: 8,
      tool_count: 64,
      read_tool_count: 32,
      write_tool_count: 32,
    });
    expect(report.raw_full_logical_entry_array_reference).toMatchObject({
      dispatchable_catalog: false,
      tool_count: 64,
      canonical_json_array_bytes: 63_960,
      canonical_json_array_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      estimated_t4_at_4_bytes_per_token: 15_990,
    });
    expect(report.logical_entry_parity).toMatchObject({
      compared_tools: 64,
      exact_entry_byte_equal_count: 0,
      lease_scope_digest_only_difference_count: 64,
      normalization: "replace only host_bound_action.invocation.lease_scope_digest with 64 ASCII zeroes",
      normalized_definition_and_byte_shape_match: true,
      normalized_definition_mismatch_tools: [],
      normalized_entry_byte_equal_count: 64,
      normalized_reference_array_bytes: 63_960,
      normalized_active_census_array_bytes: 63_960,
      normalized_array_byte_equal: true,
    });
    expect(report.logical_entry_parity.normalized_reference_array_sha256)
      .toBe(report.logical_entry_parity.normalized_active_census_array_sha256);
  });

  it("separates logical-entry arrays, production catalogs, and provider instructions", () => {
    const report = REPORT;
    expect(report.progressive_state_census).toMatchObject({
      snapshot_count: 18,
      active_phase_count: 8,
      routing_snapshot_count: 1,
      transition_snapshot_count: 8,
      terminal_snapshot_count: 1,
      peak_total_logical_tool_count: 11,
      active_business_tool_count: { min: 8, median: 8, max: 8 },
      active_total_logical_tool_count: { min: 11, median: 11, max: 11 },
      active_business_entry_array_bytes: { min: 7_944, median: 7_989, max: 8_075 },
      active_business_entry_array_t4: { min: 1_986, median: 1_998, max: 2_019 },
      active_business_tool_count_reduction_ppm: { min: 875_000, median: 875_000, max: 875_000 },
      active_business_entry_array_reduction_ppm: { min: 873_749, median: 875_094, max: 875_797 },
      active_business_entry_array_t4_reduction_ppm: { min: 873_734, median: 875_047, max: 875_797 },
      active_full_catalog_json_bytes: { min: 10_956, median: 11_363, max: 11_702 },
      active_full_catalog_t4: { min: 2_739, median: 2_841, max: 2_926 },
      active_provider_instruction_block_bytes: { min: 11_733, median: 12_140, max: 12_479 },
      active_provider_instruction_block_t4: { min: 2_934, median: 3_035.5, max: 3_120 },
      active_provider_instruction_wrapper_bytes: { min: 777, median: 777, max: 777 },
    });
    expect(report.progressive_state_census.snapshots.map((snapshot) => snapshot.capability_epoch))
      .toEqual(Array.from({ length: 18 }, (_, index) => index));
    expect(report.progressive_state_census.snapshots.map((snapshot) => snapshot.state_revision))
      .toEqual(Array.from({ length: 18 }, (_, index) => index));
  });

  it("proves compiler containment, frozen catalog exposure, and public/private separation", () => {
    const report = REPORT;

    expect(report.compiler_guards).toMatchObject({
      hierarchical_flow_accepted: true,
      flat_flow_rejected: true,
      flat_64_source_catalog_rejected: true,
    });
    expect(report.compiler_guards.flat_flow_rejection).toMatch(/68 active capabilities.*16-tool reliability budget/);
    expect(report.compiler_guards.flat_64_source_catalog_rejection).toMatch(/16-tool reliability budget/);
    expect(report.catalog_exposure_and_non_disclosure).toEqual({
      target_tools_catalog_exposed_in_frozen_census: 64,
      target_tools_total: 64,
      target_tools_catalog_exposed_once_in_frozen_no_retry_census: true,
      tools_not_catalog_exposed_in_frozen_census: [],
      tools_catalog_exposed_more_or_less_than_once: [],
      missing_target_count: 0,
      cross_group_business_tool_leakage_count: 0,
      private_binding_checks: 64,
      public_forbidden_private_key_hits: 0,
      public_private_sentinel_hits: 0,
      public_catalog_invariant_to_private_grant_expiry_and_source_order: true,
    });
    for (const snapshot of report.progressive_state_census.snapshots) {
      if (snapshot.group_id === null) {
        expect(snapshot.active_business_tools).toEqual([]);
        continue;
      }
      const expected = report.corpus.groups.find((group) => group.id === snapshot.group_id);
      expect(snapshot.active_business_tools).toEqual([...expected!.tool_names].sort());
      expect(snapshot.active_control_tools).toEqual([
        "complete_step",
        "enter_step",
        "get_flow_state",
      ]);
    }
    expect(report.claim_scope).toMatch(/not invocation success, arbitrary caller-path reachability/);
    expect(report.claim_scope).toMatch(/not .*provider\/model quality.*prompt\/token savings/);
    expect(report.estimator_note).toMatch(/rough.*not provider-reported/);
  });

  it("binds the result to exact source and observed toolchain provenance", () => {
    const report = REPORT;
    expect(report.provenance.source_manifest).toMatchObject({
      benchmark_version: "active-catalog-efficiency.v1",
      estimator_version: "utf8-ceil-div4.v1",
      serializer_versions: {
        logical_entry_array: "benchmark-artifacts.canonical-json.v1",
        full_catalog_json: "json-stringify.active-capability-catalog.v1",
        provider_instruction_block: "active-capability-catalog-instructions.v1",
      },
    });
    expect(report.provenance.source_manifest.files.map((file) => file.path)).toEqual([
      "benchmarks/voice-long-horizon/corpora/active-catalog-efficiency-64.v1.json",
      "web/lib/active-capability-catalog.ts",
      "web/lib/active-capability-flow.ts",
      "web/lib/benchmark/active-catalog-efficiency.ts",
      "web/lib/benchmark/artifacts.ts",
      "web/lib/flow-runtime.ts",
      "web/lib/flow-tool-catalog.ts",
      "web/lib/flow.ts",
      "web/lib/voice-tools/schema.ts",
    ]);
    expect(report.provenance.toolchain_manifest.observed_runtime.node).toBe(process.version);
    expect(report.provenance.toolchain_manifest.observed_packages)
      .toEqual(report.provenance.toolchain_manifest.locked_packages);
    expect(report.provenance.toolchain_manifest_sha256).toBe(sha256Hex(
      `${TOOLCHAIN_MANIFEST_HASH_DOMAIN}${canonicalJson(report.provenance.toolchain_manifest)}`
    ));
    expect(report.provenance.toolchain_manifest.declared_node_engine)
      .toBe("^20.19.0 || ^22.13.0 || >=24.0.0");
    expect(report.provenance.toolchain_manifest.declared_commands).toEqual({
      benchmark_active_catalog: "tsx scripts/active-catalog-efficiency.ts",
      db_test_integration: "node scripts/test-tenant-isolation.mjs",
    });
    expect(report.provenance.build_manifest).toMatchObject({
      benchmark_version: "active-catalog-efficiency.v1",
      construction: {
        frozen_state_census: "one preselected eight-phase sequential route; no retries",
        logical_entry_reference: "64 sorted one-source non-dispatchable authorities",
        literal_array_serializer: "benchmark-artifacts.canonical-json.v1",
      },
    });
    expect(report.evidence_hash).toBe(sha256Hex(
      `${EVIDENCE_HASH_DOMAIN}${canonicalJson({
        result_hash: report.result_hash,
        source_manifest_sha256: report.provenance.source_manifest_sha256,
        build_manifest_sha256: report.provenance.build_manifest_sha256,
        toolchain_manifest_sha256: report.provenance.toolchain_manifest_sha256,
      })}`
    ));
  });

  it("is byte-stable across independent runs in one pinned environment", () => {
    expect(canonicalJson(runActiveCatalogEfficiencyBenchmark())).toBe(canonicalJson(REPORT));
  }, 120_000);
});
