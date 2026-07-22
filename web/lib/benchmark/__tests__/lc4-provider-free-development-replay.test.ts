import { describe, expect, it } from "vitest";

import {
  analyzeVerifiedLc4ProviderFreeDevelopmentReport,
  assertLc4ProviderFreeDevelopmentReplay,
  runLc4ProviderFreeDevelopmentReplay,
  type Lc4ProviderFreeDevelopmentReplay,
} from "../lc4-provider-free-development-replay";

describe("LC4 public provider-free development replay", () => {
  it("runs the public corpus through the paired mechanism stack and emits a verified blind report", async () => {
    const replay = await runLc4ProviderFreeDevelopmentReplay();
    const inference = analyzeVerifiedLc4ProviderFreeDevelopmentReport(replay, replay.replay_sha256);

    expect(replay).toMatchObject({
      replay_id: "HACC-LC4-DEV-PROVIDER-FREE-REPLAY-v1",
      provider_free: true,
      provider_calls_authorized: false,
      provider_calls_made: 0,
      efficacy_claim_eligible: false,
      caller_automaton: { canonical_horizon: 60, completed: true },
      caller_audio_placeholders: { source_count: 72, acoustic_claim_eligible: false },
      crp: { canonical_horizon: 60, canonical_horizon_extended: false, repair_count: 4 },
      fault_coverage: {
        committed_after_error_count: 1,
        authoritative_reconciliation_count: 1,
        cancelled_job_count: 1,
        session_rotation_count: 3,
        session_count: 4,
        all_declared_fault_branches_passed: true,
        blockers: [],
      },
      report: {
        status: "provider_free_mechanism_evidence_only_no_efficacy_claim",
        scheduled_episodes: 6,
        terminal_dispositions: 6,
        evaluator_allocation_blind: true,
        bounded_mechanism_successes: 6,
      },
    });
    expect(replay.episodes).toHaveLength(6);
    expect(replay.listener_evidence).toHaveLength(6);
    expect(replay.listener_evidence.every((item) => item.artifact.coverage.listener_semantics_verified === 60)).toBe(true);
    expect(replay.listener_evidence.every((item) => item.artifact.final_scorer.all_required_semantic_criteria_pass)).toBe(true);
    expect(replay.episodes.every((episode) => episode.common_artifact_sha256 === replay.arm_common_artifact.artifact_sha256)).toBe(true);
    expect(replay.mechanism_canary.arms.native.arm_common_projection_sha256)
      .toBe(replay.mechanism_canary.arms.hacc.arm_common_projection_sha256);
    expect(replay.fault_coverage.worker_dispositions.map((item) => item.actual)).toEqual([
      "accept", "reject_stale", "accept", "reject_duplicate",
    ]);
    expect(replay.fault_coverage.declared_fault_branches).toHaveLength(11);
    expect(replay.report.blinded_rows.every((row) => !("provider" in row) && !("arm" in row))).toBe(true);
    expect(inference).toMatchObject({
      efficacy_claim_eligible: false,
      equal_provider_weight_paired_difference: 0,
      public_interpretation: "Provider-free mechanism replay passed; this is not provider efficacy evidence.",
    });
  }, 60_000);

  it("fails closed when any corpus, arm-common, listener, report, or inference root is rewritten", async () => {
    const replay = await runLc4ProviderFreeDevelopmentReplay();
    const cases: Array<[string, (copy: unknown) => void]> = [
      ["corpus", (copy) => {
        (copy as { corpus: { opportunities: Array<{ canonical_caller_text: string }> } })
          .corpus.opportunities[0]!.canonical_caller_text = "tampered";
      }],
      ["audio", (copy) => {
        (copy as { caller_audio_placeholders: { sources: Array<{ pcm_sha256: string }> } })
          .caller_audio_placeholders.sources[0]!.pcm_sha256 = "f".repeat(64);
      }],
      ["common", (copy) => {
        (copy as { arm_common_artifact: { fault_coverage_sha256: string } })
          .arm_common_artifact.fault_coverage_sha256 = "e".repeat(64);
      }],
      ["gateway", (copy) => {
        (copy as { mechanism_canary: { arms: { native: { signed_replay: { valid: boolean } } } } })
          .mechanism_canary.arms.native.signed_replay.valid = false;
      }],
      ["listener", (copy) => {
        (copy as { listener_evidence: Array<{ artifact: { records: Array<{ record_sha256: string }> } }> })
          .listener_evidence[0]!.artifact.records[0]!.record_sha256 = "d".repeat(64);
      }],
      ["report", (copy) => {
        (copy as { report: { blinded_rows: Array<{ bounded_mechanism_success: boolean }> } })
          .report.blinded_rows[0]!.bounded_mechanism_success = false;
      }],
    ];
    for (const [, mutate] of cases) {
      const copy = structuredClone(replay) as Lc4ProviderFreeDevelopmentReplay;
      mutate(copy);
      expect(() => assertLc4ProviderFreeDevelopmentReplay(copy)).toThrow();
    }
    expect(() => analyzeVerifiedLc4ProviderFreeDevelopmentReport(replay, "0".repeat(64)))
      .toThrow("inference root differs");
  }, 60_000);
});
