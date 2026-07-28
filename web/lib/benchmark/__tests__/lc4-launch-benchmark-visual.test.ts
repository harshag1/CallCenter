import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex } from "../artifacts";
import type { Lc4AuthorityObligationResult } from "../lc4-authoritative-obligation-evidence";
import {
  createLc4LaunchBenchmarkVisualBuffers,
  LC4_LAUNCH_BENCHMARK_VISUAL_FILENAMES,
  publishLc4LaunchBenchmarkVisual,
  renderLc4LaunchBenchmarkSvg,
} from "../lc4-launch-benchmark-visual";
import { runLc4LaunchBenchmarkVisualCli } from "../lc4-launch-benchmark-visual-cli";
import {
  scoreLc4LaunchBenchmark,
  type Lc4LaunchBenchmarkEpisodeInput,
  type Lc4LaunchBenchmarkScoringInput,
} from "../lc4-launch-benchmark";
import { LC4_DEV_LISTENER_SEMANTIC_BUNDLE } from "../lc4-development-listener-semantics";
import { createLc4PublicDevelopmentCorpus } from "../lc4-public-development-corpus";

const roots: string[] = [];
const H = (value: string) => sha256Hex(value);
const corpus = createLc4PublicDevelopmentCorpus();

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function authorityResults(): readonly Lc4AuthorityObligationResult[] {
  return Object.freeze(Array.from({ length: 42 }, (_, index) => Object.freeze({
    obligation_id: `authority.tool_outcome_exact.visual-${String(index).padStart(2, "0")}`,
    pass: true,
    observed_count: 1,
    reason: null,
  })));
}

function episode(
  provider: "openai" | "gemini" | "xai",
  arm: "native" | "hacc",
): Lc4LaunchBenchmarkEpisodeInput {
  return Object.freeze({
    episode_id: `${provider}-${arm}`,
    pair_id: provider,
    provider,
    arm,
    model: `${provider}-realtime`,
    opened: true,
    completed: true,
    repair_playbacks: 0,
    observations: Object.freeze(corpus.opportunities.map((opportunity) => {
      const plan = LC4_DEV_LISTENER_SEMANTIC_BUNDLE.plan.opportunities[opportunity.index - 1]!;
      const applicable = plan.applicability.status === "applicable";
      return Object.freeze({
        opportunity_id: opportunity.id,
        transcript: "Retained model-visible speech.",
        semantic_applicability: applicable ? "applicable" as const : "not_applicable" as const,
        final_required_criteria_pass: applicable ? arm === "hacc" : null,
        semantic_replay_sha256: H(`${provider}:${arm}:${opportunity.id}`),
      });
    })),
    authority: Object.freeze({
      scoreability: "scorable" as const,
      verdict: "pass" as const,
      obligation_results: authorityResults(),
      critical_external_effect_breach: false,
      replay_sha256: H(`${provider}:${arm}:authority`),
    }),
  });
}

function artifact() {
  const input: Lc4LaunchBenchmarkScoringInput = Object.freeze({
    execution_id: "visual-test",
    source_commit: "a".repeat(40),
    source_tree_sha256: H("tree"),
    run_sha256: H("run"),
    report_sha256: H("report"),
    episodes: Object.freeze((["openai", "gemini", "xai"] as const).flatMap((provider) =>
      (["native", "hacc"] as const).map((arm) => episode(provider, arm)))),
  });
  return scoreLc4LaunchBenchmark(input);
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "hacc-lc4-visual-"));
  roots.push(root);
  return root;
}

describe("LC4 launch benchmark visual", () => {
  it("renders only exact recall counts and strict outcomes from the complete v2 artifact", () => {
    const svg = renderLc4LaunchBenchmarkSvg(artifact());
    expect(svg).toContain("Long-call recall");
    expect(svg).toContain("Registered recall probes · exact pass rate");
    expect(svg).toContain("360 registered opportunities across 6 calls");
    expect(svg).toContain("One registered development scenario per provider");
    expect(svg).toContain("HACC 0/1");
    expect(svg.match(/class="value"/gu)).toHaveLength(6);
    expect(svg).not.toMatch(/Verified results|1000 (?:voice|registered|interactions)|guardrail|authoritative actions/iu);
  });

  it("produces deterministic 1600×1000 SVG, PNG, and WebP buffers", async () => {
    const result = await createLc4LaunchBenchmarkVisualBuffers(artifact());
    const repeated = await createLc4LaunchBenchmarkVisualBuffers(artifact());
    expect(result).toEqual(repeated);
    const [png, webp] = await Promise.all([
      sharp(result.png).metadata(),
      sharp(result.webp).metadata(),
    ]);
    expect(png).toMatchObject({ format: "png", width: 1600, height: 1000 });
    expect(webp).toMatchObject({ format: "webp", width: 1600, height: 1000 });
  });

  it("publishes an immutable three-file asset set and refuses overwrite", async () => {
    const root = await tempRoot();
    const json = resolve(root, "HACC_LC4_LAUNCH_BENCHMARK.json");
    const output = resolve(root, "visual");
    const source = artifact();
    await writeFile(json, `${canonicalJson(source)}\n`, { mode: 0o444 });
    const published = await publishLc4LaunchBenchmarkVisual({
      public_json: json,
      output_root: output,
    });
    expect(published.benchmark_sha256).toBe(source.benchmark_sha256);
    for (const filename of Object.values(LC4_LAUNCH_BENCHMARK_VISUAL_FILENAMES)) {
      const metadata = await stat(resolve(output, filename));
      expect(metadata.isFile()).toBe(true);
      expect(metadata.mode & 0o777).toBe(0o444);
    }
    expect(await readFile(resolve(output, LC4_LAUNCH_BENCHMARK_VISUAL_FILENAMES.svg), "utf8"))
      .toContain(source.benchmark_sha256);
    await expect(publishLc4LaunchBenchmarkVisual({
      public_json: json,
      output_root: output,
    })).rejects.toThrow(/overwrite is forbidden/u);
  });

  it("fails closed before writing when the v2 artifact is incomplete or tampered", async () => {
    const root = await tempRoot();
    const json = resolve(root, "tampered.json");
    const output = resolve(root, "visual");
    const tampered = structuredClone(artifact());
    (tampered.cells as Array<(typeof tampered.cells)[number]>).pop();
    await writeFile(json, `${JSON.stringify(tampered)}\n`);
    await expect(publishLc4LaunchBenchmarkVisual({
      public_json: json,
      output_root: output,
    })).rejects.toThrow(/hash mismatch|complete six-episode/u);
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the visual CLI provider-free and rejects broad or malformed inputs", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    await expect(runLc4LaunchBenchmarkVisualCli(
      ["publish", "--public-json", "/tmp/result.json"],
      { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) },
    )).resolves.toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "LC4 launch benchmark visual CLI requires exactly: --output-root, --public-json",
    ]);
  });
});
