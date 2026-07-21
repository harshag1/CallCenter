import artifact from "../../../../benchmarks/voice-long-horizon/scenarios/tool-world-causal-containment.v1.json";
import provenance from "../../../../benchmarks/voice-long-horizon/scenarios/tool-world-causal-containment.v1.provenance.json";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TOOL_WORLD_CAUSAL_CASES,
  runToolWorldCausalContainment,
} from "../tool-world-causal-containment";
import { verifyToolWorldCausalProvenanceManifest } from "../tool-world-causal-provenance";

const REPO_ROOT = resolve(process.cwd(), "..");

describe("ToolWorld deterministic causal containment", () => {
  it("reproduces the checked machine-readable artifact exactly", () => {
    const first = runToolWorldCausalContainment();
    const second = runToolWorldCausalContainment();

    expect(first).toEqual(second);
    expect(first).toEqual(artifact);
    expect(first.provider_calls).toBe(0);
    expect(first.trial_count).toBe(160);
    expect(first.design_status).toBe("fixed-development-design");
    expect(first.result_hash).toBe("f1969525a34e2144aa7487ba6e639aaab9e38f1149733d05817dfe42657fceab");
  });

  it("contains every fixed development schedule and reports descriptive intervals", () => {
    const report = runToolWorldCausalContainment();

    expect(report.aggregate).toMatchObject({
      attempted: 160,
      naive_comparator_unsafe_accept_count: 160,
      harness_contained_count: 160,
      harness_corrupt_state_rejection_count: 64,
      harness_idempotent_suppression_count: 96,
    });
    expect(report.aggregate.harness_containment_wilson_95.lower).toBeGreaterThan(0.97);
    expect(report.aggregate.harness_containment_wilson_95.upper).toBe(1);

    for (const caseName of TOOL_WORLD_CAUSAL_CASES) {
      expect(report.cases[caseName]).toMatchObject({
        attempted: 32,
        naive_comparator_unsafe_accept_count: 32,
        harness_contained_count: 32,
      });
      expect(report.cases[caseName].harness_containment_wilson_95.lower).toBeGreaterThan(0.89);
      expect(report.cases[caseName].harness_containment_wilson_95.upper).toBe(1);
    }
    expect(report.claim_scope).toMatch(/not realtime-model quality/);
  });

  it("validates bounded deterministic seed ranges", () => {
    expect(runToolWorldCausalContainment({ seed_start: 1, seeds_per_case: 1 }).design_status)
      .toBe("exploratory-variant");
    expect(() => runToolWorldCausalContainment({ seed_start: -1 })).toThrow(/non-negative/);
    expect(() => runToolWorldCausalContainment({ seeds_per_case: 0 })).toThrow(/1\.\.1000/);
    expect(() => runToolWorldCausalContainment({ seeds_per_case: 1_001 })).toThrow(/1\.\.1000/);
    expect(() => runToolWorldCausalContainment({ seed_start: 0xffff_ffff, seeds_per_case: 2 })).toThrow(/unsigned 32-bit/);
  });

  it("binds the artifact to exact clean-base source bytes and rejects substitution", () => {
    const verified = verifyToolWorldCausalProvenanceManifest(REPO_ROOT, provenance);
    expect(verified).toEqual({ valid: true, errors: [] });
    expect(provenance.tracked_base).toMatchObject({
      capture_worktree_dirty: false,
      claim: "tracked base before the selected worktree bytes; not a clean-build claim",
    });
    expect(provenance.sources.every((source) => source.relation_to_tracked_base === "matches-base"))
      .toBe(true);

    for (const source of provenance.sources) {
      const substitutedPath = resolve(REPO_ROOT, source.path);
      const substituted = verifyToolWorldCausalProvenanceManifest(REPO_ROOT, provenance, (path) => {
        const bytes = readFileSync(path);
        return path === substitutedPath ? Buffer.concat([bytes, Buffer.from("\n// substituted\n")]) : bytes;
      });
      expect(substituted.valid, source.path).toBe(false);
      expect(substituted.errors, source.path).toEqual(expect.arrayContaining([
        `${source.path}: byte_length mismatch`,
        `${source.path}: sha256 mismatch`,
      ]));
    }
  });
});
