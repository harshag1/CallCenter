import { describe, expect, it } from "vitest";

import { sha256Hex } from "../artifacts";
import type { Lc4AuthorityObligationResult } from "../lc4-authoritative-obligation-evidence";
import { runLc4LaunchBenchmarkCli } from "../lc4-launch-benchmark-cli";
import {
  LC4_LAUNCH_BENCHMARK_SCORE_POLICY_SHA256,
  renderLc4LaunchBenchmarkMarkdown,
  scoreLc4LaunchBenchmark,
  type Lc4LaunchBenchmarkEpisodeInput,
  type Lc4LaunchBenchmarkScoringInput,
} from "../lc4-launch-benchmark";
import { LC4_DEV_LISTENER_SEMANTIC_BUNDLE } from "../lc4-development-listener-semantics";
import { createLc4PublicDevelopmentCorpus } from "../lc4-public-development-corpus";

const H = (value: string) => sha256Hex(value);
const corpus = createLc4PublicDevelopmentCorpus();

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
