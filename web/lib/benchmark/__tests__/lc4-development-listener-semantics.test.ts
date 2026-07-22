import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex } from "../artifacts";
import type { ConditionBlindListenerObservation } from "../audible-evidence";
import {
  LC4_DEV_LISTENER_PLAN_SHA256,
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
} from "../lc4-development-listener-semantics";
import { createLc4PublicDevelopmentCorpus } from "../lc4-public-development-corpus";

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
    evaluator_build_sha256: H("evaluator-build"),
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

  it("replays a long-horizon corrected-date and corrected-format answer deterministically", () => {
    const transcript = "The current visit is August twentieth, and the current format is a tagged screen-reader PDF.";
    const first = replay(transcript);
    const second = replay(transcript);
    expect(first).toEqual(second);
    expect(first.final_required_criteria_pass).toBe(true);
    expect(first.semantic_replay.criteria.map((criterion) => criterion.pass)).toEqual([true, true]);
    expect(verifyLc4DevelopmentListenerReplayArtifact({ artifact: first })).toEqual({ valid: true, errors: [] });
  });

  it("retains a semantic failure as evidence instead of converting it to ambiguity or a pass", () => {
    const artifact = replay("The current visit is August twentieth.");
    expect(artifact.final_required_criteria_pass).toBe(false);
    expect(artifact.semantic_replay.criteria.map((criterion) => criterion.pass)).toEqual([true, false]);
    expect(artifact.semantic_replay.earliest_unmet_crp_blocker).toBe("latest_revision_unacknowledged");
    expect(verifyLc4DevelopmentListenerReplayArtifact({ artifact })).toEqual({ valid: true, errors: [] });
  });

  it("detects retained transcript, criterion-result, and artifact-root mutation offline", () => {
    const artifact = replay("August twentieth and tagged screen-reader PDF");
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

  it("fails closed when ASR evidence, exact PCM, or the criterion binding is mutated", () => {
    const binding = lc4DevelopmentListenerCriterionBindings().find((item) => item.opportunity_id === "lc4-dev-op-50")!;
    const observation = verifiedObservation("August twentieth and tagged screen-reader PDF");
    const common = {
      opportunity_id: "lc4-dev-op-50",
      criterion_plan_sha256: binding.criterion_plan_sha256,
      source_pcm_sha256: PCM_SHA256,
      source_pcm_byte_length: PCM_BYTE_LENGTH,
      evaluator_contract_sha256: H("asr-contract"),
      evaluator_build_sha256: H("evaluator-build"),
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
