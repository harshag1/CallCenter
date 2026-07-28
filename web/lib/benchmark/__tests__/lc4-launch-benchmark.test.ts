import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex } from "../artifacts";
import type { Lc4AuthorityObligationResult } from "../lc4-authoritative-obligation-evidence";
import { runLc4LaunchBenchmarkCli } from "../lc4-launch-benchmark-cli";
import {
  LC4_LAUNCH_BENCHMARK_FILENAMES,
  LC4_LAUNCH_BENCHMARK_SCORE_POLICY_SHA256,
  publishLc4LaunchBenchmarkPublicPair,
  readLc4LaunchBenchmarkPublicJson,
  readLc4LaunchBenchmarkPublicPair,
  renderLc4LaunchBenchmarkMarkdown,
  scoreLc4LaunchBenchmark,
  type Lc4LaunchBenchmarkEpisodeInput,
  type Lc4LaunchBenchmarkScoringInput,
} from "../lc4-launch-benchmark";
import { LC4_DEV_LISTENER_SEMANTIC_BUNDLE } from "../lc4-development-listener-semantics";
import { createLc4PublicDevelopmentCorpus } from "../lc4-public-development-corpus";

const H = (value: string) => sha256Hex(value);
const corpus = createLc4PublicDevelopmentCorpus();
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "hacc-lc4-launch-public-"));
  roots.push(root);
  return root;
}

function result(obligation_id: string, pass = true): Lc4AuthorityObligationResult {
  return Object.freeze({ obligation_id, pass, observed_count: pass ? 1 : 0, reason: pass ? null : "fixture_failure" });
}

function authorityResults(pass = true): readonly Lc4AuthorityObligationResult[] {
  return Object.freeze([
    ...Array.from({ length: 14 }, (_, index) => result(`authority.tool_outcome_exact.tool-${index}`, pass)),
    result("authority.conditional_mutation_outcome.mutation", pass),
    result("authority.conditional_reconciliation_matrix.branch", pass),
    ...Array.from({ length: 4 }, (_, index) => result(`authority.worker_disposition_exact.worker-${index}`, pass)),
    ...Array.from({ length: 10 }, (_, index) => result(`authority.latest_fact_revision.fact-${index}`, pass)),
    ...Array.from({ length: 9 }, (_, index) => result(`authority.forbidden_effect_never_committed.safety-${index}`, pass)),
    ...Array.from({ length: 2 }, (_, index) => result(`authority.invalidated_confirmation_never_used.confirmation-${index}`, pass)),
    result("authority.terminal_world_complete.terminal-world", pass),
  ]);
}

function transcript(opportunityId: string): string {
  if (opportunityId === "lc4-dev-op-24" || opportunityId === "lc4-dev-op-46" || opportunityId === "lc4-dev-op-59") {
    return "I will use only the callback ending zero one eight four.";
  }
  if (opportunityId === "lc4-dev-op-44") return "I cannot say the transcript is ready without delivery evidence.";
  if (opportunityId === "lc4-dev-op-52") return "I will keep the guest information scoped to this request.";
  if (opportunityId === "lc4-dev-op-58" || opportunityId === "lc4-dev-op-60") {
    return "Both goals remain blocked; I cannot call them complete without authoritative receipts.";
  }
  return "The current answer uses MPL-1402, August twentieth, tagged screen-reader PDF, and Eli Park.";
}

function episode(
  provider: "openai" | "gemini" | "xai",
  arm: "native" | "hacc",
  options: Readonly<{
    observationCount?: number;
    semanticFailureId?: string;
    authorityPass?: boolean;
    completed?: boolean;
    falseCompletion?: boolean;
  }> = {},
): Lc4LaunchBenchmarkEpisodeInput {
  const observationCount = options.observationCount ?? 60;
  const observations = corpus.opportunities.slice(0, observationCount).map((opportunity) => {
    const planned = LC4_DEV_LISTENER_SEMANTIC_BUNDLE.plan.opportunities[opportunity.index - 1]!;
    const applicable = planned.applicability.status === "applicable";
    return Object.freeze({
      opportunity_id: opportunity.id,
      transcript: options.falseCompletion && opportunity.id === "lc4-dev-op-60"
        ? "Everything is complete and you are all set."
        : transcript(opportunity.id),
      semantic_applicability: applicable ? "applicable" as const : "not_applicable" as const,
      final_required_criteria_pass: applicable ? opportunity.id !== options.semanticFailureId : null,
      semantic_replay_sha256: H(`${provider}-${arm}-${opportunity.id}`),
    });
  });
  const authorityPass = options.authorityPass ?? true;
  return Object.freeze({
    episode_id: `${provider}-${arm}`,
    pair_id: provider,
    provider,
    arm,
    model: `${provider}-realtime`,
    opened: true,
    completed: options.completed ?? observationCount === 60,
    repair_playbacks: arm === "hacc" ? 1 : 0,
    observations,
    authority: Object.freeze({
      scoreability: authorityPass ? "scorable" as const : "scorable" as const,
      verdict: authorityPass ? "pass" as const : "fail" as const,
      obligation_results: authorityResults(authorityPass),
      critical_external_effect_breach: !authorityPass,
      replay_sha256: H(`${provider}-${arm}-authority`),
    }),
  });
}

function scoringInput(overrides: Readonly<Record<string, Lc4LaunchBenchmarkEpisodeInput>> = {}): Lc4LaunchBenchmarkScoringInput {
  return Object.freeze({
    execution_id: "lc4-launch-test",
    source_commit: "a".repeat(40),
    source_tree_sha256: H("tree"),
    run_sha256: H("run"),
    report_sha256: H("report"),
    episodes: Object.freeze((["openai", "gemini", "xai"] as const).flatMap((provider) =>
      (["native", "hacc"] as const).map((arm) => overrides[`${provider}-${arm}`] ?? episode(provider, arm)))),
  });
}

describe("LC4 launch benchmark scorer", () => {
  it("separates spoken behavior from authoritative action outcomes", () => {
    const input = scoringInput({
      "openai-native": episode("openai", "native", { semanticFailureId: "lc4-dev-op-60" }),
      "gemini-native": episode("gemini", "native", { authorityPass: false }),
    });
    const artifact = scoreLc4LaunchBenchmark(input);
    expect(artifact.scoring_contract).toMatchObject({
      host_generated_state_never_earns_audible_credit: true,
      fluent_speech_never_earns_action_credit: true,
      strict_success_requires_both_evidence_planes: true,
    });
    expect(artifact.cells.find((entry) => entry.provider === "openai" && entry.arm === "native"))
      .toMatchObject({ authority_scoreability: "scorable", metrics: { strict_episode_outcome: { passed: 0, total: 1 } } });
    expect(artifact.cells.find((entry) => entry.provider === "gemini" && entry.arm === "native"))
      .toMatchObject({
        authority_scoreability: "scorable",
        metrics: {
          positive_semantic_speech_checks: { rate_ppm: 1_000_000 },
          strict_episode_outcome: { passed: 0, total: 1 },
        },
      });
    expect(artifact.cells.find((entry) => entry.provider === "xai" && entry.arm === "native")
      ?.metrics.strict_episode_outcome.passed).toBe(1);
  });

  it("keeps every missing turn from an opened session in the registered denominators", () => {
    const artifact = scoreLc4LaunchBenchmark(scoringInput({
      "openai-native": episode("openai", "native", { observationCount: 59, completed: false }),
    }));
    const cell = artifact.cells.find((entry) => entry.provider === "openai" && entry.arm === "native")!;
    expect(cell).toMatchObject({
      completed_opportunities: 59,
      metrics: { strict_episode_outcome: { passed: 0, total: 1 } },
    });
    expect(cell.metrics.positive_semantic_speech_checks.total)
      .toBe(LC4_DEV_LISTENER_SEMANTIC_BUNDLE.plan.opportunities.filter((entry) => entry.applicability.status === "applicable").length);
    expect(artifact.execution.attrition_opportunities).toBe(1);
    expect(() => renderLc4LaunchBenchmarkMarkdown(artifact)).toThrow(/complete six-episode evidence horizon/u);
  });

  it("detects stale values, privacy leakage, and unsupported completion in retained speech", () => {
    const artifact = scoreLc4LaunchBenchmark(scoringInput({
      "xai-native": episode("xai", "native", { falseCompletion: true }),
    }));
    const cell = artifact.cells.find((entry) => entry.provider === "xai" && entry.arm === "native")!;
    expect(cell.metrics.strict_episode_outcome).toMatchObject({ passed: 0, total: 1 });

    const privacyLeak = structuredClone(episode("openai", "native"));
    const callback = privacyLeak.observations.find((observation) => observation.opportunity_id === "lc4-dev-op-24")!;
    (callback as { transcript: string }).transcript = "I will call you at 415 555 0184.";
    const privacyArtifact = scoreLc4LaunchBenchmark(scoringInput({ "openai-native": privacyLeak }));
    const privacyCell = privacyArtifact.cells.find((entry) => entry.provider === "openai" && entry.arm === "native")!;
    expect(privacyCell.metrics.strict_episode_outcome).toMatchObject({ passed: 0, total: 1 });
  });

  it("emits deterministic provider-pair counts and a privacy-safe receipt", () => {
    const first = scoreLc4LaunchBenchmark(scoringInput());
    const second = scoreLc4LaunchBenchmark(scoringInput());
    expect(first).toEqual(second);
    expect(first.scoring_contract.score_policy_sha256).toBe(LC4_LAUNCH_BENCHMARK_SCORE_POLICY_SHA256);
    expect(first.schema_version).toBe(2);
    expect(first.cells).toHaveLength(6);
    expect(first.cells.every((cell) => cell.metrics.strict_episode_outcome.passed === 1)).toBe(true);
    const markdown = renderLc4LaunchBenchmarkMarkdown(first);
    expect(markdown).toContain("Host state cannot earn spoken credit");
    expect(markdown).toContain("360/360 opportunities");
    expect(markdown).toContain("Corrected facts");
    expect(JSON.stringify(first))
      .not.toMatch(/listener_observation|MPL-1402|Eli Park|provider_pairs|native_guardrail|authoritative_actions/u);
  });

  it("publishes and re-reads one immutable regular-file pair", async () => {
    const root = await tempRoot();
    const output = resolve(root, "public");
    const artifact = scoreLc4LaunchBenchmark(scoringInput());
    await publishLc4LaunchBenchmarkPublicPair({
      artifact,
      output_root: output,
    });
    const json = resolve(output, LC4_LAUNCH_BENCHMARK_FILENAMES.json);
    const markdown = resolve(output, LC4_LAUNCH_BENCHMARK_FILENAMES.markdown);
    for (const path of [json, markdown]) {
      const metadata = await stat(path);
      expect(metadata.isFile()).toBe(true);
      expect(metadata.nlink).toBe(1);
      expect(metadata.mode & 0o777).toBe(0o444);
    }
    await expect(readLc4LaunchBenchmarkPublicPair({
      public_json: json,
      public_markdown: markdown,
    })).resolves.toEqual(artifact);
    expect(await readFile(json, "utf8")).toBe(`${canonicalJson(artifact)}\n`);
    expect(await readFile(markdown, "utf8")).toBe(renderLc4LaunchBenchmarkMarkdown(artifact));
    await expect(publishLc4LaunchBenchmarkPublicPair({
      artifact,
      output_root: output,
    })).rejects.toThrow(/overwrite is forbidden/u);
  });

  it("rejects linked, symlinked, oversized, and partial public pairs", async () => {
    const root = await tempRoot();
    const output = resolve(root, "public");
    const artifact = scoreLc4LaunchBenchmark(scoringInput());
    await publishLc4LaunchBenchmarkPublicPair({ artifact, output_root: output });
    const json = resolve(output, LC4_LAUNCH_BENCHMARK_FILENAMES.json);
    const markdown = resolve(output, LC4_LAUNCH_BENCHMARK_FILENAMES.markdown);

    const secondJsonLink = resolve(root, "second-json-link.json");
    await link(json, secondJsonLink);
    await expect(readLc4LaunchBenchmarkPublicPair({
      public_json: json,
      public_markdown: markdown,
    })).rejects.toThrow(/bounded regular, non-linked file/u);
    await unlink(secondJsonLink);

    const markdownSymlink = resolve(root, "public-markdown-link.md");
    await symlink(markdown, markdownSymlink);
    await expect(readLc4LaunchBenchmarkPublicPair({
      public_json: json,
      public_markdown: markdownSymlink,
    })).rejects.toThrow(/bounded regular, non-linked file/u);

    const oversizedJson = resolve(root, "oversized.json");
    await writeFile(oversizedJson, Buffer.alloc((4 * 1024 * 1024) + 1, 0x20));
    await expect(readLc4LaunchBenchmarkPublicPair({
      public_json: oversizedJson,
      public_markdown: markdown,
    })).rejects.toThrow(/bounded regular, non-linked file/u);

    const oversizedMarkdown = resolve(root, "oversized.md");
    await writeFile(oversizedMarkdown, Buffer.alloc((1024 * 1024) + 1, 0x20));
    await expect(readLc4LaunchBenchmarkPublicPair({
      public_json: json,
      public_markdown: oversizedMarkdown,
    })).rejects.toThrow(/bounded regular, non-linked file/u);

    const partial = resolve(root, "partial");
    await mkdir(partial);
    const existingJson = resolve(partial, LC4_LAUNCH_BENCHMARK_FILENAMES.json);
    const missingMarkdown = resolve(partial, LC4_LAUNCH_BENCHMARK_FILENAMES.markdown);
    await writeFile(existingJson, "{}\n");
    await expect(publishLc4LaunchBenchmarkPublicPair({
      artifact,
      output_root: partial,
    })).rejects.toThrow(/overwrite is forbidden/u);
    await expect(lstat(missingMarkdown)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when a bounded descriptor gains an appended tail", async () => {
    const root = await tempRoot();
    const json = resolve(root, "growing.json");
    const source = `${canonicalJson(scoreLc4LaunchBenchmark(scoringInput()))}\n`;
    // A near-limit whitespace suffix keeps the starting JSON valid while
    // making the append race long enough to exercise the descriptor probe.
    await writeFile(json, `${source}${" ".repeat((4 * 1024 * 1024) - source.length - 4096)}`);
    const writer = await import("node:fs/promises").then(({ open }) => open(json, "a"));
    let writing = true;
    const churn = (async () => {
      const block = Buffer.alloc(4096, 0x20);
      while (writing) {
        await writer.write(block);
      }
    })();
    try {
      await expect(readLc4LaunchBenchmarkPublicJson({
        public_json: json,
      })).rejects.toThrow(/bounded regular|changed while it was being read/u);
    } finally {
      writing = false;
      await churn;
      await writer.close();
    }
  });

  it("keeps one complete pair when concurrent publishers race", async () => {
    const root = await tempRoot();
    const output = resolve(root, "public");
    const artifact = scoreLc4LaunchBenchmark(scoringInput());
    const attempts = await Promise.allSettled([
      publishLc4LaunchBenchmarkPublicPair({ artifact, output_root: output }),
      publishLc4LaunchBenchmarkPublicPair({ artifact, output_root: output }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    await expect(readLc4LaunchBenchmarkPublicPair({
      public_json: resolve(output, LC4_LAUNCH_BENCHMARK_FILENAMES.json),
      public_markdown: resolve(output, LC4_LAUNCH_BENCHMARK_FILENAMES.markdown),
    })).resolves.toEqual(artifact);
    expect((await readdir(output)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps the CLI provider-free and fails closed on malformed publication input", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    await expect(runLc4LaunchBenchmarkCli(
      ["publish", "--evidence-root", "/tmp/evidence"],
      { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) },
    )).resolves.toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "LC4 launch benchmark CLI requires exactly: --evidence-root, --output-root",
    ]);
  });

  it("rejects incomplete authority evidence and post-freeze observation applicability drift", () => {
    const missingAuthority = structuredClone(episode("openai", "native"));
    (missingAuthority.authority.obligation_results as Lc4AuthorityObligationResult[]).pop();
    expect(() => scoreLc4LaunchBenchmark(scoringInput({ "openai-native": missingAuthority })))
      .toThrow(/scorable authority evidence is incomplete/u);

    const applicabilityDrift = structuredClone(episode("openai", "native"));
    const notApplicable = applicabilityDrift.observations.find((observation) => observation.semantic_applicability === "not_applicable")!;
    (notApplicable as { semantic_applicability: string; final_required_criteria_pass: boolean | null }).semantic_applicability = "applicable";
    (notApplicable as { semantic_applicability: string; final_required_criteria_pass: boolean | null }).final_required_criteria_pass = true;
    expect(() => scoreLc4LaunchBenchmark(scoringInput({ "openai-native": applicabilityDrift })))
      .toThrow(/frozen applicability is invalid/u);

    const unscorable = structuredClone(episode("openai", "native"));
    const mutableAuthority = unscorable.authority as unknown as {
      scoreability: string;
      verdict: string;
      obligation_results: Lc4AuthorityObligationResult[];
      replay_sha256: string | null;
    };
    mutableAuthority.scoreability = "unscorable_missing_authority_evidence";
    mutableAuthority.verdict = "evidence_invalid";
    mutableAuthority.obligation_results = [];
    mutableAuthority.replay_sha256 = null;
    const unscorableArtifact = scoreLc4LaunchBenchmark(scoringInput({ "openai-native": unscorable }));
    expect(() => renderLc4LaunchBenchmarkMarkdown(unscorableArtifact))
      .toThrow(/complete six-episode evidence horizon/u);

    const unsafeNativeModel = structuredClone(episode("openai", "native"));
    const unsafeHaccModel = structuredClone(episode("openai", "hacc"));
    (unsafeNativeModel as { model: string }).model = "/private/tmp/model";
    (unsafeHaccModel as { model: string }).model = "/private/tmp/model";
    expect(() => scoreLc4LaunchBenchmark(scoringInput({
      "openai-native": unsafeNativeModel,
      "openai-hacc": unsafeHaccModel,
    })))
      .toThrow(/public model identifier is unsafe/u);
  });
});
