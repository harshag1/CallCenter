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
  assertLc4LaunchBenchmarkArtifact,
  LC4_LAUNCH_BENCHMARK_FILENAMES,
  LC4_LAUNCH_BENCHMARK_SCORE_POLICY_SHA256,
  publishLc4LaunchBenchmark,
  readLc4LaunchBenchmarkPublicJson,
  readLc4LaunchBenchmarkPublicPair,
  renderLc4LaunchBenchmarkMarkdown,
  scoreLc4LaunchBenchmark,
  unsafePublishLc4LaunchBenchmarkPublicPairForTestsOnly,
  type Lc4LaunchBenchmarkEpisodeInput,
  type Lc4LaunchBenchmarkScoringInput,
} from "../lc4-launch-benchmark";
import { LC4_DEV_LISTENER_SEMANTIC_BUNDLE } from "../lc4-development-listener-semantics";
import {
  lc4DevCallerBranchSemanticSubjectId,
  type Lc4DevPriorMutationOutcome,
} from "../lc4-development-caller-branch";
import { createLc4PublicDevelopmentCorpus } from "../lc4-public-development-corpus";
import { LC4_PROVIDER_PROFILE_MANIFEST } from "../lc4-provider-profiles";
import {
  createLc4PublicationTransportProvenance,
} from "../lc4-publication-transport-provenance";
import {
  createLc4PublicationTransportReplay,
} from "../lc4-publication-transport-replay";
import {
  createLc4ProviderExecutionProfile,
} from "../lc4-production-runner-foundation";

const H = (value: string) => sha256Hex(value);
const corpus = createLc4PublicDevelopmentCorpus();
const roots: string[] = [];

function transportReplay() {
  return createLc4PublicationTransportReplay({
    run_sha256: H("run"),
    provider_profile_manifest_sha256:
      LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
    audio_delivery_profile_sha256: H("audio-delivery"),
    listener_authority_trust_root_sha256:
      H("listener-authority-trust-root"),
    canonical_provider_exchange_count: 360,
    repair_provider_exchange_count: 0,
    total_response_generation_count: 360,
    episodes: (["openai", "gemini", "xai"] as const).flatMap((provider) => {
      const profile = createLc4ProviderExecutionProfile(provider);
      return (["native", "hacc"] as const).map((arm) => ({
        episode_id: `${provider}-${arm}`,
        provider,
        arm,
        model: profile.model,
        transport_purpose: provider === "xai"
          ? "finite_prerecorded_efficacy" as const
          : null,
        transport_mode: "manual_commit" as const,
        transport_profile_sha256:
          profile.transport_profile_sha256 ?? profile.provider_profile_sha256,
        output_audio_lineage_scope: provider === "gemini"
          ? "client_observed_interval_wire_projection_capture_cas_evaluator_exact_complete_frame_attribution_provider_response_id_unavailable" as const
          : "client_observed_identity_scoped_wire_pcm_capture_cas_evaluator_exact" as const,
        canonical_provider_exchange_count: 60 as const,
        repair_provider_exchange_count: 0,
        total_response_generation_count: 60,
        canonical_exchange_replay_set_sha256:
          H(`${provider}-${arm}-canonical-exchange-replay-set`),
        response_generation_replay_set_sha256:
          H(`${provider}-${arm}-response-generation-replay-set`),
        listener_authority_replay_set_sha256:
          H(`${provider}-${arm}-listener-authority-replay-set`),
        listener_invocation_replay_set_sha256:
          H(`${provider}-${arm}-listener-invocation-replay-set`),
      }));
    }),
  });
}

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
    firstResponseFailureId?: string;
    branchOutcome?: Lc4DevPriorMutationOutcome;
  }> = {},
): Lc4LaunchBenchmarkEpisodeInput {
  const observationCount = options.observationCount ?? 60;
  const branchOutcome = options.branchOutcome ?? "no_call";
  const repairedOpportunityId = arm === "hacc" ? "lc4-dev-op-10" : null;
  const observations = corpus.opportunities.slice(0, observationCount).map((opportunity) => {
    const semanticSubjectId = opportunity.id === "lc4-dev-op-42"
      ? lc4DevCallerBranchSemanticSubjectId(branchOutcome)
      : opportunity.id;
    const planned = LC4_DEV_LISTENER_SEMANTIC_BUNDLE.plan.opportunities.find(
      (candidate) => candidate.opportunity_id === semanticSubjectId,
    )!;
    const applicable = planned.applicability.status === "applicable";
    const finalTranscript = options.falseCompletion && opportunity.id === "lc4-dev-op-60"
      ? "Everything is complete and you are all set."
      : transcript(opportunity.id);
    const repairPlayed = opportunity.id === repairedOpportunityId;
    const firstResponseLineage = Object.freeze({
      provider_exchange_sha256:
        H(`${provider}-${arm}-${opportunity.id}-first-exchange`),
      listener_evidence_sha256:
        H(`${provider}-${arm}-${opportunity.id}-first-listener`),
      assistant_pcm_sha256:
        H(`${provider}-${arm}-${opportunity.id}-first-assistant-pcm`),
    });
    const firstResponse = Object.freeze({
      semantic_subject_id: semanticSubjectId,
      branch_outcome: opportunity.id === "lc4-dev-op-42" ? branchOutcome : null,
      response_lineage: firstResponseLineage,
      transcript: finalTranscript,
      semantic_applicability: applicable ? "applicable" as const : "not_applicable" as const,
      final_required_criteria_pass: applicable
        ? opportunity.id !== (options.firstResponseFailureId
          ?? (repairPlayed ? repairedOpportunityId : options.semanticFailureId))
        : null,
      semantic_replay_sha256: H(`${provider}-${arm}-${opportunity.id}-first`),
    });
    const repairAssisted = repairPlayed
      ? Object.freeze({
          ...firstResponse,
          response_lineage: Object.freeze({
            provider_exchange_sha256:
              H(`${provider}-${arm}-${opportunity.id}-repair-exchange`),
            listener_evidence_sha256:
              H(`${provider}-${arm}-${opportunity.id}-repair-listener`),
            assistant_pcm_sha256:
              H(`${provider}-${arm}-${opportunity.id}-repair-assistant-pcm`),
          }),
          final_required_criteria_pass: applicable
            ? opportunity.id !== options.semanticFailureId
            : null,
          semantic_replay_sha256: H(`${provider}-${arm}-${opportunity.id}-repair`),
        })
      : Object.freeze({
          ...firstResponse,
          final_required_criteria_pass: applicable
            ? opportunity.id !== options.semanticFailureId
            : null,
        });
    return Object.freeze({
      opportunity_id: opportunity.id,
      repair_played: repairPlayed,
      first_response: firstResponse,
      repair_assisted: repairAssisted,
    });
  });
  const authorityPass = options.authorityPass ?? true;
  return Object.freeze({
    episode_id: `${provider}-${arm}`,
    pair_id: provider,
    provider,
    arm,
    model: LC4_PROVIDER_PROFILE_MANIFEST.providers[provider].model,
    opened: true,
    completed: options.completed ?? observationCount === 60,
    repair_playbacks: arm === "hacc" ? 1 : 0,
    total_response_generations: observationCount + (arm === "hacc" ? 1 : 0),
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
    evidence: Object.freeze({
      prepare_sha256: H("prepare"),
      preflight_sha256: H("preflight"),
      run_ledger_head_sha256: H("run-ledger-head"),
      run_package_sha256: H("run-package"),
      budget_lease_sha256: H("budget-lease"),
      budget_evidence_sha256: H("budget-evidence"),
      budget_terminal_ledger_head_sha256: H("budget-terminal-head"),
      budget_ledger_public_key_fingerprint_sha256: H("budget-public-key"),
      authority_replay_set_sha256: H("authority-replay-set"),
    }),
    budget: Object.freeze({
      maximum_total_micro_usd: 15_000_000,
      conservative_settled_micro_usd: 12_000_000,
      active_reservations_micro_usd: 0 as const,
      reservations_terminal: true as const,
      reservation_count: 6 as const,
      budget_replay_verified: true as const,
    }),
    transport_provenance: createLc4PublicationTransportProvenance({
      retained_gate_b_receipt_sha256: H("gate-b-receipt"),
      xai_finite_manual_gate_d_receipt_sha256: H("gate-d-receipt"),
      transport_replay: transportReplay(),
      qualification_replay_sha256: {
        openai: H("openai-gate-b-replay"),
        gemini: H("gemini-gate-b-replay"),
        xai: H("xai-gate-d-replay"),
      },
      model_identity_verification: {
        openai: "provider_verified",
        gemini: "request_only",
        xai: "provider_verified",
      },
    }),
    episodes: Object.freeze((["openai", "gemini", "xai"] as const).flatMap((provider) =>
      (["native", "hacc"] as const).map((arm) => overrides[`${provider}-${arm}`] ?? episode(provider, arm)))),
  });
}

function rehashBenchmarkOnly(
  artifact: ReturnType<typeof scoreLc4LaunchBenchmark>,
): void {
  const { benchmark_sha256: _claimed, ...body } = artifact;
  void _claimed;
  (artifact as { benchmark_sha256: string }).benchmark_sha256 = sha256Hex(
    `harshas-amazing-call-center/lc4-launch-benchmark/v7\n${canonicalJson(body)}`,
  );
}

function rehashEvidenceRootAndBenchmark(
  artifact: ReturnType<typeof scoreLc4LaunchBenchmark>,
): void {
  const {
    completed_evidence_root_sha256: _claimed,
    ...evidence
  } = artifact.evidence;
  void _claimed;
  (artifact.evidence as { completed_evidence_root_sha256: string })
    .completed_evidence_root_sha256 = sha256Hex(
      `harshas-amazing-call-center/lc4-launch-completed-evidence-root/v2\n${canonicalJson({
        execution_id: artifact.execution.execution_id,
        source_commit: artifact.execution.source_commit,
        source_tree_sha256: artifact.execution.source_tree_sha256,
        evidence,
        budget: artifact.budget,
      })}`,
    );
  rehashBenchmarkOnly(artifact);
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

  it("publishes first-response and repair-assisted estimands with exact generation and lineage accounting", () => {
    const artifact = scoreLc4LaunchBenchmark(scoringInput());
    const native = artifact.cells.find((entry) =>
      entry.provider === "openai" && entry.arm === "native")!;
    const hacc = artifact.cells.find((entry) =>
      entry.provider === "openai" && entry.arm === "hacc")!;

    expect(artifact.scoring_contract).toMatchObject({
      first_response_estimand:
        "registered audible semantics on the initial response before repair",
      repair_assisted_estimand:
        "registered audible semantics on the effective response after the deterministic repair policy",
      strict_episode_uses: "repair_assisted_outcome",
      repair_policy:
        "pre_registered_deterministic_same_opportunity_no_horizon_extension",
      caller_prompt_parity:
        "identical_canonical_prompts_before_registered_outcome_dependent_branch_only",
    });
    expect(native.adaptive_repair).toMatchObject({
      branch_outcome: "no_call",
      repair_playback_count: 0,
      total_response_generations: 60,
    });
    expect(native.adaptive_repair.first_response_semantic_score)
      .toEqual(native.adaptive_repair.repair_assisted_semantic_score);
    expect(native.adaptive_repair.first_response_lineage_root_sha256)
      .toBe(native.adaptive_repair.repair_assisted_lineage_root_sha256);

    expect(hacc.adaptive_repair).toMatchObject({
      branch_outcome: "no_call",
      repair_playback_count: 1,
      total_response_generations: 61,
      first_response_semantic_score: {
        passed:
          hacc.adaptive_repair.repair_assisted_semantic_score.total - 1,
      },
      repair_assisted_semantic_score: {
        passed: hacc.adaptive_repair.repair_assisted_semantic_score.total,
      },
    });
    expect(hacc.adaptive_repair.first_response_lineage_root_sha256)
      .not.toBe(hacc.adaptive_repair.repair_assisted_lineage_root_sha256);
    expect(hacc.metrics.positive_semantic_speech_checks)
      .toEqual(hacc.adaptive_repair.repair_assisted_semantic_score);

    const markdown = renderLc4LaunchBenchmarkMarkdown(artifact);
    expect(markdown).toContain("First response is scored before");
    expect(markdown).toContain("provider-exchange, listener-evidence, and assistant-PCM hashes");
    expect(markdown).toContain("identical only before the registered outcome-dependent branch");
  });

  it("rejects op42 branch substitution and adaptive repair accounting or lineage mutation", () => {
    const branchMutation = structuredClone(episode("openai", "native"));
    const branchObservation = branchMutation.observations.find(
      (observation) => observation.opportunity_id === "lc4-dev-op-42",
    )!;
    for (const phase of [
      branchObservation.first_response,
      branchObservation.repair_assisted,
    ]) {
      (phase as { branch_outcome: Lc4DevPriorMutationOutcome })
        .branch_outcome = "settled_success";
    }
    expect(() => scoreLc4LaunchBenchmark(scoringInput({
      "openai-native": branchMutation,
    }))).toThrow(/branch, or frozen applicability is invalid/u);

    const repairCountMutation = structuredClone(episode("openai", "hacc"));
    (repairCountMutation as { repair_playbacks: number }).repair_playbacks = 0;
    (repairCountMutation as { total_response_generations: number })
      .total_response_generations = 60;
    expect(() => scoreLc4LaunchBenchmark(scoringInput({
      "openai-hacc": repairCountMutation,
    }))).toThrow(/adaptive repair accounting is invalid/u);

    const repairLineageMutation = structuredClone(episode("openai", "hacc"));
    const repaired = repairLineageMutation.observations.find(
      (observation) => observation.repair_played,
    )!;
    (repaired.repair_assisted.response_lineage as {
      assistant_pcm_sha256: string;
    }).assistant_pcm_sha256 =
      repaired.first_response.response_lineage.assistant_pcm_sha256;
    expect(() => scoreLc4LaunchBenchmark(scoringInput({
      "openai-hacc": repairLineageMutation,
    }))).toThrow(/repair phase identity is invalid/u);

    const publicLineageMutation = structuredClone(
      scoreLc4LaunchBenchmark(scoringInput()),
    );
    const haccCell = publicLineageMutation.cells.find((cell) =>
      cell.provider === "openai" && cell.arm === "hacc")!;
    (haccCell.adaptive_repair as {
      repair_assisted_lineage_root_sha256: string;
    }).repair_assisted_lineage_root_sha256 =
      haccCell.adaptive_repair.first_response_lineage_root_sha256;
    rehashBenchmarkOnly(publicLineageMutation);
    expect(() => assertLc4LaunchBenchmarkArtifact(publicLineageMutation))
      .toThrow(/complete six-episode evidence horizon/u);
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
      .toBe(new Set(LC4_DEV_LISTENER_SEMANTIC_BUNDLE.plan.opportunities
        .filter((entry) => entry.applicability.status === "applicable")
        .map((entry) => entry.opportunity_id.startsWith("lc4-dev-op-42:")
          ? "lc4-dev-op-42"
          : entry.opportunity_id)).size);
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
    (callback.first_response as { transcript: string }).transcript =
      "I will call you at 415 555 0184.";
    (callback.repair_assisted as { transcript: string }).transcript =
      "I will call you at 415 555 0184.";
    const privacyArtifact = scoreLc4LaunchBenchmark(scoringInput({ "openai-native": privacyLeak }));
    const privacyCell = privacyArtifact.cells.find((entry) => entry.provider === "openai" && entry.arm === "native")!;
    expect(privacyCell.metrics.strict_episode_outcome).toMatchObject({ passed: 0, total: 1 });
  });

  it("emits deterministic provider-pair counts and a privacy-safe receipt", () => {
    const first = scoreLc4LaunchBenchmark(scoringInput());
    const second = scoreLc4LaunchBenchmark(scoringInput());
    expect(first).toEqual(second);
    expect(first.scoring_contract.score_policy_sha256).toBe(LC4_LAUNCH_BENCHMARK_SCORE_POLICY_SHA256);
    expect(first.schema_version).toBe(7);
    expect(first.comparison_design).toEqual({
      registered_native_comparator: {
        public_label: "Registered Native comparator",
        definition: "Native realtime API + common benchmark continuity",
        receives_common_benchmark_continuity: true,
        receives_hacc_state_projection: false,
        is_bare_or_context_free_model_or_api_baseline: false,
        is_consumer_chatgpt_voice: false,
      },
      hacc_public_label: "HACC",
      provider_pair_count: 3,
      pairs_per_provider: 1,
      episodes_per_pair: 2,
      opportunity_accounting: {
        calls: 6,
        opportunities_per_call: 60,
        repeated_opportunity_observations: 360,
        opportunities_are_independent_trials: false,
        inferential_status:
          "nested_repeated_opportunities_not_independent_trials_C3_descriptive_only",
      },
    });
    expect(first.budget).toEqual({
      maximum_total_micro_usd: 15_000_000,
      conservative_settled_micro_usd: 12_000_000,
      active_reservations_micro_usd: 0,
      reservations_terminal: true,
      reservation_count: 6,
      budget_replay_verified: true,
    });
    expect(first.evidence).toMatchObject({
      run_sha256: H("run"),
      report_sha256: H("report"),
      budget_terminal_ledger_head_sha256: H("budget-terminal-head"),
      authority_replay_set_sha256: H("authority-replay-set"),
    });
    expect(first.cells).toHaveLength(6);
    expect(first.cells.find((cell) =>
      cell.provider === "xai" && cell.arm === "hacc")).toMatchObject({
        turn_boundary_control: "client_explicit",
        wire_turn_boundary:
          "finite_clip_input_audio_buffer.commit_then_response.create",
        transport_purpose: "finite_prerecorded_efficacy",
        model_identity_verification: "provider_verified",
        qualification_scope: "xai_finite_manual_gate_d_exact_transport",
        qualification_receipt_sha256: H("gate-d-receipt"),
      });
    expect(first.qualification).toMatchObject({
      xai_finite_manual_transport_qualification: "verified",
      xai_finite_manual_claim_boundary:
        "transport_qualification_only_not_efficacy_evidence",
    });
    expect(first.cells.every((cell) => cell.metrics.strict_episode_outcome.passed === 1)).toBe(true);
    const markdown = renderLc4LaunchBenchmarkMarkdown(first);
    expect(markdown).toContain("Host state cannot earn spoken credit");
    expect(markdown).toContain("360/360 opportunities");
    expect(markdown).toContain("Registered Native comparator means Native realtime API + common benchmark continuity");
    expect(markdown).toContain("360 opportunities are repeated within 6 calls, not 360 independent trials");
    expect(markdown).not.toContain("Native API versus HACC");
    expect(markdown).toContain("Corrected facts");
    expect(markdown).toContain("Budget replay: verified, 0 active reservation liability");
    expect(markdown).toContain("Completed evidence root:");
    expect(markdown).toContain("| xai | Registered Native comparator | finite_prerecorded_efficacy | client_explicit | finite_clip_input_audio_buffer.commit_then_response.create | provider_verified | xai_finite_manual_gate_d_exact_transport |");
    expect(markdown).toContain("| xai | HACC | finite_prerecorded_efficacy | client_explicit | finite_clip_input_audio_buffer.commit_then_response.create | provider_verified | xai_finite_manual_gate_d_exact_transport |");
    expect(JSON.stringify(first))
      .not.toMatch(/listener_observation|MPL-1402|Eli Park|provider_pairs|native_guardrail|authoritative_actions/u);
  });

  it("fails closed when comparator or repeated-opportunity semantics drift", () => {
    const comparatorDrift = structuredClone(
      scoreLc4LaunchBenchmark(scoringInput()),
    );
    (comparatorDrift.comparison_design.registered_native_comparator as {
      definition: string;
    }).definition = "bare native API";
    rehashBenchmarkOnly(comparatorDrift);
    expect(() => assertLc4LaunchBenchmarkArtifact(comparatorDrift))
      .toThrow(/complete six-episode evidence horizon/u);

    const independenceDrift = structuredClone(
      scoreLc4LaunchBenchmark(scoringInput()),
    );
    (independenceDrift.comparison_design.opportunity_accounting as {
      opportunities_are_independent_trials: boolean;
    }).opportunities_are_independent_trials = true;
    rehashBenchmarkOnly(independenceDrift);
    expect(() => assertLc4LaunchBenchmarkArtifact(independenceDrift))
      .toThrow(/complete six-episode evidence horizon/u);
  });

  it("binds terminal budget replay and rejects tampered budget authority", () => {
    const settledCostTamper = structuredClone(
      scoreLc4LaunchBenchmark(scoringInput()),
    );
    (settledCostTamper.budget as { conservative_settled_micro_usd: number })
      .conservative_settled_micro_usd += 1;
    rehashBenchmarkOnly(settledCostTamper);
    expect(() => assertLc4LaunchBenchmarkArtifact(settledCostTamper))
      .toThrow(/complete six-episode evidence horizon/u);

    const terminalHeadTamper = structuredClone(
      scoreLc4LaunchBenchmark(scoringInput()),
    );
    (terminalHeadTamper.evidence as {
      budget_terminal_ledger_head_sha256: string;
    }).budget_terminal_ledger_head_sha256 = H("substituted-terminal-head");
    rehashBenchmarkOnly(terminalHeadTamper);
    expect(() => assertLc4LaunchBenchmarkArtifact(terminalHeadTamper))
      .toThrow(/complete six-episode evidence horizon/u);

    // Even a caller who recomputes both public hashes cannot turn an active
    // reservation into a publishable terminal budget.
    const activeReservationTamper = structuredClone(
      scoreLc4LaunchBenchmark(scoringInput()),
    );
    (activeReservationTamper.budget as {
      active_reservations_micro_usd: number;
    }).active_reservations_micro_usd = 1;
    rehashEvidenceRootAndBenchmark(activeReservationTamper);
    expect(() => assertLc4LaunchBenchmarkArtifact(activeReservationTamper))
      .toThrow(/complete six-episode evidence horizon/u);

    const directScoringInput = structuredClone(scoringInput());
    (directScoringInput.budget as {
      active_reservations_micro_usd: number;
    }).active_reservations_micro_usd = 1;
    expect(() => scoreLc4LaunchBenchmark(directScoringInput))
      .toThrow(/replayed terminal budget with zero active reservations/u);
  });

  it("rejects caller-built artifacts and a missing evidence root on the release publisher", async () => {
    const root = await tempRoot();
    const output = resolve(root, "public");
    const synthetic = scoreLc4LaunchBenchmark(scoringInput());
    const gateD = {
      receipt_path: resolve(root, "missing-gate-d-receipt.json"),
      invocation_marker_path: resolve(root, "missing-gate-d-marker.json"),
      plan_trust_root_sha256: H("gate-d-trust-root"),
    };
    await expect(publishLc4LaunchBenchmark({
      artifact: synthetic,
      output_root: output,
      xai_finite_manual_gate_d: gateD,
    } as never)).rejects.toThrow(/evidence root/u);
    await expect(publishLc4LaunchBenchmark({
      evidence_root: resolve(root, "missing-evidence-root"),
      output_root: output,
      authority_trust_root_sha256: H("listener-authority-trust-root"),
      xai_finite_manual_gate_d: gateD,
    })).rejects.toThrow();
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes and re-reads one immutable regular-file pair", async () => {
    const root = await tempRoot();
    const output = resolve(root, "public");
    const artifact = scoreLc4LaunchBenchmark(scoringInput());
    await unsafePublishLc4LaunchBenchmarkPublicPairForTestsOnly({
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
    await expect(unsafePublishLc4LaunchBenchmarkPublicPairForTestsOnly({
      artifact,
      output_root: output,
    })).rejects.toThrow(/overwrite is forbidden/u);
  });

  it("rejects linked, symlinked, oversized, and partial public pairs", async () => {
    const root = await tempRoot();
    const output = resolve(root, "public");
    const artifact = scoreLc4LaunchBenchmark(scoringInput());
    await unsafePublishLc4LaunchBenchmarkPublicPairForTestsOnly({ artifact, output_root: output });
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
    await expect(unsafePublishLc4LaunchBenchmarkPublicPairForTestsOnly({
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
      unsafePublishLc4LaunchBenchmarkPublicPairForTestsOnly({ artifact, output_root: output }),
      unsafePublishLc4LaunchBenchmarkPublicPairForTestsOnly({ artifact, output_root: output }),
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
      "LC4 launch benchmark CLI requires exactly: --authority-trust-root-sha256, --evidence-root, --gate-d-invocation-marker, --gate-d-receipt, --gate-d-trust-root-sha256, --output-root",
    ]);
  });

  it("rejects incomplete authority evidence and post-freeze observation applicability drift", () => {
    const missingAuthority = structuredClone(episode("openai", "native"));
    (missingAuthority.authority.obligation_results as Lc4AuthorityObligationResult[]).pop();
    expect(() => scoreLc4LaunchBenchmark(scoringInput({ "openai-native": missingAuthority })))
      .toThrow(/scorable authority evidence is incomplete/u);

    const applicabilityDrift = structuredClone(episode("openai", "native"));
    const notApplicable = applicabilityDrift.observations.find((observation) =>
      observation.first_response.semantic_applicability
        === "not_applicable")!;
    for (const phase of [
      notApplicable.first_response,
      notApplicable.repair_assisted,
    ]) {
      (phase as {
        semantic_applicability: string;
        final_required_criteria_pass: boolean | null;
      }).semantic_applicability = "applicable";
      (phase as {
        semantic_applicability: string;
        final_required_criteria_pass: boolean | null;
      }).final_required_criteria_pass = true;
    }
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
