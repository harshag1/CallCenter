import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex } from "../artifacts";
import type { ConditionBlindListenerObservation } from "../audible-evidence";
import {
  LC4_DEV_LISTENER_CRITERIA_SOURCE_CORPUS_SHA256,
  LC4_DEV_LISTENER_EVALUATOR_BUILD_SHA256,
  LC4_DEV_LISTENER_EVALUATOR_IMPLEMENTATION_VERSION,
  LC4_DEV_LISTENER_PLAN_SHA256,
  LC4_DEV_LISTENER_PROTOCOL_MIGRATION,
  LC4_DEV_LISTENER_REGISTRY_MANIFEST_SHA256,
  LC4_DEV_LISTENER_REGISTRY_SHA256,
  LC4_DEV_LISTENER_SCHEDULE_SHA256,
  LC4_DEV_LISTENER_SEMANTIC_BUNDLE,
  assertLc4DevelopmentListenerSemanticBundle,
  createLc4DevelopmentListenerSemanticBundle,
  lc4DevelopmentAsrBlindNonceSha256,
  lc4DevelopmentListenerCriterionBindings,
  replayLc4DevelopmentListenerObservation,
  type Lc4DevelopmentListenerSemanticBundle,
  verifyLc4DevelopmentListenerReplayArtifact,
  verifyLc4DevelopmentListenerProtocolMigration,
} from "../lc4-development-listener-semantics";
import {
  LC4_PUBLIC_DEV_BLOCKER_ORDER,
  createLc4PublicDevelopmentCorpus,
} from "../lc4-public-development-corpus";

const OBSERVATION_DOMAIN = "hacc/condition-blind-listener-observation/v1\n";
const H = (value: string) => sha256Hex(value);
const PCM_SHA256 = H("exact-played-pcm");
const PCM_BYTE_LENGTH = 9_600;

function verifiedObservation(transcript: string): Extract<ConditionBlindListenerObservation, { status: "verified" }> {
  const body = Object.freeze({
    schema_version: 1 as const,
    source: "independent_played_pcm_asr" as const,
    status: "verified" as const,
    observation_id: H("condition-blind-observation"),
    played_pcm_sha256: PCM_SHA256,
    played_through_sample: PCM_BYTE_LENGTH / 2,
    transcript,
    transcript_sha256: sha256Hex(Buffer.from(transcript, "utf8")),
    timed_spans: Object.freeze([{
      span_id: "span-1",
      text: transcript,
      utf8_start: 0,
      utf8_end: Buffer.byteLength(transcript, "utf8"),
      audio_start_sample: 0,
      audio_end_sample: PCM_BYTE_LENGTH / 2,
      confidence_ppm: 950_000,
    }]),
  });
  return Object.freeze({
    ...body,
    evidence_sha256: sha256Hex(`${OBSERVATION_DOMAIN}${canonicalJson(body)}`),
  });
}

function replay(transcript: string, opportunityId = "lc4-dev-op-50") {
  const binding = lc4DevelopmentListenerCriterionBindings().find((item) => item.opportunity_id === opportunityId)!;
  return replayLc4DevelopmentListenerObservation({
    opportunity_id: opportunityId,
    criterion_plan_sha256: binding.criterion_plan_sha256,
    source_pcm_sha256: PCM_SHA256,
    source_pcm_byte_length: PCM_BYTE_LENGTH,
    evaluator_contract_sha256: H("asr-contract"),
    evaluator_build_sha256: LC4_DEV_LISTENER_EVALUATOR_BUILD_SHA256,
    calibration_sha256: H("calibration"),
    signed_invocation_receipt_sha256: H("signed-invocation"),
    observation: verifiedObservation(transcript),
  });
}

describe("LC4 public development listener semantics", () => {
  it("source-freezes one provider/arm-common criterion plan for all 60 opportunities", () => {
    const bundle = createLc4DevelopmentListenerSemanticBundle();
    expect(bundle.schedule_sha256).toBe(LC4_DEV_LISTENER_SCHEDULE_SHA256);
    expect(bundle.registry.registry_sha256).toBe(LC4_DEV_LISTENER_REGISTRY_SHA256);
    expect(bundle.manifest.manifest_sha256).toBe(LC4_DEV_LISTENER_REGISTRY_MANIFEST_SHA256);
    expect(bundle.plan.plan_sha256).toBe(LC4_DEV_LISTENER_PLAN_SHA256);
    expect(bundle.corpus_sha256).not.toBe(LC4_DEV_LISTENER_CRITERIA_SOURCE_CORPUS_SHA256);
    expect(bundle.plan.opportunities).toHaveLength(60);
    expect(new Set(bundle.plan.opportunities.map((item) => item.opportunity_id))).toHaveLength(60);

    const corpus = createLc4PublicDevelopmentCorpus();
    for (const opportunity of corpus.opportunities) {
      const planned = bundle.plan.opportunities[opportunity.index - 1];
      expect(planned?.opportunity_id).toBe(opportunity.id);
      if (opportunity.expected_oracle.required_listener_semantics.length > 0) {
        expect(planned?.criteria.length).toBeGreaterThan(0);
        expect(planned?.criteria.every((criterion) => criterion.required_for_final_scorer)).toBe(true);
      }
    }
    expect(lc4DevelopmentListenerCriterionBindings(bundle)).toHaveLength(60);
  });

  it("binds each stage deadline to exactly the two blockers in its frozen CRP inventory", () => {
    const corpus = createLc4PublicDevelopmentCorpus();
    for (const deadline of [10, 20, 30, 40, 50, 60]) {
      const opportunity = corpus.opportunities[deadline - 1]!;
      const planned = LC4_DEV_LISTENER_SEMANTIC_BUNDLE.plan.opportunities[deadline - 1]!;
      const criterionBlockers = [...new Set(planned.criteria
        .map((criterion) => criterion.crp_blocker?.code)
        .filter((blocker): blocker is NonNullable<typeof blocker> => blocker !== undefined))].sort();
      const criterionPrecedence = planned.criteria.map((criterion) =>
        LC4_PUBLIC_DEV_BLOCKER_ORDER.indexOf(criterion.crp_blocker!.code));
      const repairBlockers = [...new Set(corpus.repair_policy.library
        .filter((repair) => repair.stage_id === opportunity.stage_id)
        .map((repair) => repair.blocker_code))].sort();
      expect(criterionBlockers, `deadline ${deadline}`).toEqual(repairBlockers);
      expect(criterionPrecedence, `deadline ${deadline} blocker precedence`)
        .toEqual([...criterionPrecedence].sort((left, right) => left - right));
      expect(repairBlockers, `deadline ${deadline}`).toHaveLength(2);
      for (const blocker of repairBlockers) {
        expect(corpus.repair_policy.library
          .filter((repair) => repair.stage_id === opportunity.stage_id && repair.blocker_code === blocker)
          .map((repair) => repair.repair_ordinal)).toEqual([1, 2]);
      }
    }
  });

  it("records the intentional pre-provider protocol migration and rejects post-hoc edits", () => {
    const migration = LC4_DEV_LISTENER_PROTOCOL_MIGRATION;
    expect(verifyLc4DevelopmentListenerProtocolMigration(migration)).toEqual({ valid: true, errors: [] });
    expect(migration.timing).toBe("before_first_paid_voice_episode");
    expect(migration.provider_output_used).toBe(false);
    expect(migration.efficacy_claim_eligible).toBe(false);
    expect(migration.changed_opportunity_ids).toEqual([
      "lc4-dev-op-06", "lc4-dev-op-07", "lc4-dev-op-08", "lc4-dev-op-09",
      "lc4-dev-op-13", "lc4-dev-op-14", "lc4-dev-op-18", "lc4-dev-op-24",
      "lc4-dev-op-25", "lc4-dev-op-31", "lc4-dev-op-34", "lc4-dev-op-35",
      "lc4-dev-op-42", "lc4-dev-op-43", "lc4-dev-op-44", "lc4-dev-op-51",
      "lc4-dev-op-52", "lc4-dev-op-56",
    ]);
    expect(migration.current.registry_sha256).toBe(LC4_DEV_LISTENER_REGISTRY_SHA256);
    expect(migration.current.plan_sha256).toBe(LC4_DEV_LISTENER_PLAN_SHA256);
    expect(migration.current.registry_sha256).not.toBe(migration.prior.registry_sha256);
    expect(migration.current.evaluator_build_sha256).not.toBe(migration.prior.evaluator_build_sha256);

    const postHocCriteriaEdit = {
      ...migration,
      current: { ...migration.current, registry_sha256: H("post-hoc-criterion-edit") },
    } as typeof migration;
    expect(verifyLc4DevelopmentListenerProtocolMigration(postHocCriteriaEdit).valid).toBe(false);
    expect(verifyLc4DevelopmentListenerProtocolMigration({
      ...migration,
      migration_sha256: H("post-hoc-migration-edit"),
    }).errors).toContain("LC4-DEV listener migration hash mismatch");
  });

  it("replays a long-horizon corrected-date and corrected-format answer deterministically", () => {
    const transcript = "I can confirm the current proposal: the visit is August twentieth and the format is a tagged screen-reader PDF.";
    const first = replay(transcript);
    const second = replay(transcript);
    expect(first).toEqual(second);
    expect(first.final_required_criteria_pass).toBe(true);
    expect(first.semantic_replay.criteria.map((criterion) => criterion.pass)).toEqual([true, true, true]);
    expect(verifyLc4DevelopmentListenerReplayArtifact({ artifact: first })).toEqual({ valid: true, errors: [] });
  });

  it("retains a semantic failure as evidence instead of converting it to ambiguity or a pass", () => {
    const artifact = replay("The current visit is August twentieth.");
    expect(artifact.final_required_criteria_pass).toBe(false);
    expect(artifact.semantic_replay.criteria.map((criterion) => criterion.pass)).toEqual([true, false, false]);
    expect(artifact.semantic_replay.earliest_unmet_crp_blocker).toBe("latest_revision_unacknowledged");
    expect(verifyLc4DevelopmentListenerReplayArtifact({ artifact })).toEqual({ valid: true, errors: [] });
  });

  it("detects retained transcript, criterion-result, and artifact-root mutation offline", () => {
    const artifact = replay("I confirm the current proposal for August twentieth and a tagged screen-reader PDF");
    const transcriptMutation = {
      ...artifact,
      listener_observation: {
        ...artifact.listener_observation,
        transcript: "August eighteenth and large print paper",
      },
    } as typeof artifact;
    expect(verifyLc4DevelopmentListenerReplayArtifact({ artifact: transcriptMutation }).valid).toBe(false);

    const resultMutation = {
      ...artifact,
      semantic_replay: {
        ...artifact.semantic_replay,
        final_required_criteria_pass: false,
      },
    } as typeof artifact;
    expect(verifyLc4DevelopmentListenerReplayArtifact({ artifact: resultMutation }).errors)
      .toContain("LC4-DEV retained semantic result does not replay from the frozen criteria");

    expect(verifyLc4DevelopmentListenerReplayArtifact({
      artifact: { ...artifact, artifact_sha256: H("mutated-artifact") },
    }).errors).toContain("LC4-DEV replay artifact hash mismatch");
  });

  it("rotates evaluator implementation evidence without rotating or weakening frozen criteria", () => {
    const current = replay("I confirm the current proposal for August twentieth and a tagged screen-reader PDF");
    const priorBuildSha256 = H("lc4-dev-semantic-evaluator-v1-before-headless-authority");
    const binding = lc4DevelopmentListenerCriterionBindings().find((item) => item.opportunity_id === "lc4-dev-op-50")!;
    const prior = replayLc4DevelopmentListenerObservation({
      opportunity_id: "lc4-dev-op-50",
      criterion_plan_sha256: binding.criterion_plan_sha256,
      source_pcm_sha256: PCM_SHA256,
      source_pcm_byte_length: PCM_BYTE_LENGTH,
      evaluator_contract_sha256: H("asr-contract"),
      evaluator_build_sha256: priorBuildSha256,
      calibration_sha256: H("calibration"),
      signed_invocation_receipt_sha256: H("signed-invocation"),
      observation: verifiedObservation("I confirm the current proposal for August twentieth and a tagged screen-reader PDF"),
    });

    expect(LC4_DEV_LISTENER_EVALUATOR_IMPLEMENTATION_VERSION).toContain("headless-complete-capture");
    expect(current.evaluator_build_sha256).toBe(LC4_DEV_LISTENER_EVALUATOR_BUILD_SHA256);
    expect(current.evaluator_build_sha256).not.toBe(prior.evaluator_build_sha256);
    expect(current.semantic_plan_sha256).toBe(prior.semantic_plan_sha256);
    expect(current.semantic_registry_sha256).toBe(prior.semantic_registry_sha256);
    expect(current.semantic_replay).toEqual(prior.semantic_replay);

    const defaultVerification = verifyLc4DevelopmentListenerReplayArtifact({ artifact: prior });
    expect(defaultVerification.valid).toBe(false);
    expect(defaultVerification.errors).toContain(
      "LC4-DEV replay evaluator build differs from the explicitly selected implementation",
    );
    expect(verifyLc4DevelopmentListenerReplayArtifact({
      artifact: prior,
      expected_evaluator_build_sha256: priorBuildSha256,
    })).toEqual({ valid: true, errors: [] });
  });

  it("fails closed when ASR evidence, exact PCM, or the criterion binding is mutated", () => {
    const binding = lc4DevelopmentListenerCriterionBindings().find((item) => item.opportunity_id === "lc4-dev-op-50")!;
    const observation = verifiedObservation("August twentieth and tagged screen-reader PDF");
    const common = {
      opportunity_id: "lc4-dev-op-50",
      criterion_plan_sha256: binding.criterion_plan_sha256,
      source_pcm_sha256: PCM_SHA256,
      source_pcm_byte_length: PCM_BYTE_LENGTH,
      evaluator_contract_sha256: H("asr-contract"),
      evaluator_build_sha256: LC4_DEV_LISTENER_EVALUATOR_BUILD_SHA256,
      calibration_sha256: H("calibration"),
      signed_invocation_receipt_sha256: H("signed-invocation"),
      observation,
    } as const;

    expect(() => replayLc4DevelopmentListenerObservation({ ...common, criterion_plan_sha256: H("mutated-plan") }))
      .toThrow(/frozen registry/u);
    expect(() => replayLc4DevelopmentListenerObservation({ ...common, source_pcm_sha256: H("other-pcm") }))
      .toThrow(/exact played PCM/u);
    expect(() => replayLc4DevelopmentListenerObservation({
      ...common,
      observation: Object.freeze({ ...observation, evidence_sha256: H("mutated-evidence") }),
    })).toThrow(/evidence hash is invalid/u);
    expect(() => replayLc4DevelopmentListenerObservation({
      ...common,
      observation: Object.freeze({
        schema_version: 1 as const,
        source: "independent_played_pcm_asr" as const,
        status: "unverifiable" as const,
        observation_id: H("condition-blind-observation"),
        played_pcm_sha256: PCM_SHA256,
        played_through_sample: PCM_BYTE_LENGTH / 2,
        reasons: Object.freeze(["asr_unavailable" as const]),
        evidence_sha256: H("unverifiable"),
      }),
    })).toThrow(/refuses missing or unverifiable/u);
  });

  it("rejects post-freeze corpus and semantic-plan mutation", () => {
    const corpus = createLc4PublicDevelopmentCorpus();
    const mutatedCorpus = { ...corpus, artifact_sha256: H("post-output-corpus-edit") };
    expect(() => createLc4DevelopmentListenerSemanticBundle(mutatedCorpus)).toThrow(/artifact commitment mismatch/u);

    const mutatedBundle = {
      ...LC4_DEV_LISTENER_SEMANTIC_BUNDLE,
      plan: {
        ...LC4_DEV_LISTENER_SEMANTIC_BUNDLE.plan,
        opportunities: LC4_DEV_LISTENER_SEMANTIC_BUNDLE.plan.opportunities.slice(0, 59),
      },
    } as unknown as Lc4DevelopmentListenerSemanticBundle;
    expect(() => assertLc4DevelopmentListenerSemanticBundle(mutatedBundle)).toThrow(/source-frozen public corpus/u);
  });

  it("derives the ASR blind nonce without provider, arm, episode, or flow state", () => {
    const binding = lc4DevelopmentListenerCriterionBindings().find((item) => item.opportunity_id === "lc4-dev-op-50")!;
    const input = Object.freeze({
      source_pcm_sha256: PCM_SHA256,
      source_pcm_byte_length: PCM_BYTE_LENGTH,
      criterion_plan_sha256: binding.criterion_plan_sha256,
      evaluator_contract_sha256: H("asr-contract"),
    });
    expect(Object.keys(input).sort()).toEqual([
      "criterion_plan_sha256",
      "evaluator_contract_sha256",
      "source_pcm_byte_length",
      "source_pcm_sha256",
    ]);
    expect(lc4DevelopmentAsrBlindNonceSha256(input)).toBe(lc4DevelopmentAsrBlindNonceSha256({ ...input }));
    expect(lc4DevelopmentAsrBlindNonceSha256({ ...input, source_pcm_sha256: H("mutated-pcm") }))
      .not.toBe(lc4DevelopmentAsrBlindNonceSha256(input));
  });
});
