import { canonicalJson, immutableJson, sha256Hex } from "./artifacts";
import {
  conditionBlindListenerObservation,
  createIndependentAsrRequest,
  independentAsrCalibrationSha256,
  independentAsrContractSha256,
  prepareAudibleSemanticUnit,
  runIndependentAsrAdapter,
  type ConditionBlindListenerObservation,
  type IndependentAsrAdapterExecution,
  type IndependentAsrAdapterInput,
  type IndependentAsrContract,
  type PreparedIndependentAsrCalibration,
} from "./audible-evidence";
import type { BenchmarkKernelAttestationSigner } from "./kernel-attestation";
import {
  createLc4DevArmBlindRepairProjection,
  Lc4PinnedListenerEvaluation,
  Lc4PinnedListenerEvaluator,
} from "./lc4-development-headless-listener-authority";
import {
  LC4_DEV_BRANCH_OPPORTUNITY_ID,
  LC4_DEV_CALLER_BRANCH_SOURCES,
  LC4_DEV_PRIOR_MUTATION_OUTCOMES,
  lc4DevCallerBranchSemanticSubjectId,
  type Lc4DevPriorMutationOutcome,
} from "./lc4-development-caller-branch";
import {
  LC4_PUBLIC_DEV_BLOCKER_ORDER,
  LC4_PUBLIC_DEV_PROTOCOL_ID,
  assertLc4PublicDevelopmentCorpus,
  createLc4PublicDevelopmentCorpus,
  type Lc4PublicDevelopmentCorpus,
  type Lc4PublicDevOpportunity,
} from "./lc4-public-development-corpus";
import {
  LC4_LISTENER_SEMANTIC_SCORER_BUILD_SHA256,
  LC4_LISTENER_SEMANTIC_SCORER_VERSION,
  createLc4FrozenListenerSemanticRegistry,
  createLc4FrozenListenerSemanticRegistryManifest,
  createLc4ListenerSemanticPlan,
  replayLc4ListenerSemantics,
  type Lc4CrpBlockerCode,
  type Lc4FrozenListenerSemanticRegistry,
  type Lc4FrozenListenerSemanticRegistryManifest,
  type Lc4ListenerSemanticCriterion,
  type Lc4ListenerSemanticPlan,
  type Lc4ListenerSemanticReplay,
} from "./lc4-listener-evidence";

const SHA256 = /^[a-f0-9]{64}$/u;
const OBSERVATION_DOMAIN = "hacc/condition-blind-listener-observation/v1\n";
const DEV_PROTOCOL_DOMAIN = "harshas-amazing-call-center/lc4-dev-listener-protocol/v1\n";
const DEV_SCHEDULE_DOMAIN = "harshas-amazing-call-center/lc4-dev-listener-schedule/v1\n";
const DEV_EVALUATOR_BUILD_DOMAIN = "harshas-amazing-call-center/lc4-dev-semantic-evaluator-build/v1\n";
const DEV_BLIND_NONCE_DOMAIN = "harshas-amazing-call-center/lc4-dev-asr-blind-nonce/v1\n";
const DEV_OBSERVATION_NONCE_DOMAIN = "harshas-amazing-call-center/lc4-dev-listener-observation-nonce/v1\n";
const DEV_REPLAY_DOMAIN = "harshas-amazing-call-center/lc4-dev-listener-replay-artifact/v1\n";
const DEV_PROTOCOL_MIGRATION_DOMAIN = "harshas-amazing-call-center/lc4-dev-listener-protocol-migration/v1\n";

export const LC4_DEV_LISTENER_SEMANTIC_VERSION =
  "lc4-dev-listener-semantics-v4-negation-aware-branch-complete" as const;
export const LC4_DEV_LISTENER_CRITERIA_SOURCE_CORPUS_SHA256 = "075cfbb0b4c914d409f8c0232d11314c27621e082087b20d8a658fc6e8248bfc";
export const LC4_DEV_LISTENER_PROTOCOL_SHA256 = sha256Hex(
  `${DEV_PROTOCOL_DOMAIN}${LC4_PUBLIC_DEV_PROTOCOL_ID}\nplayed-pcm-only\nprovider-arm-blind\nfrozen-before-output`,
);
export const LC4_DEV_LISTENER_EVALUATOR_IMPLEMENTATION_VERSION =
  "lc4-dev-semantic-evaluator-v4-headless-complete-capture-negation-aware-branch-complete" as const;
export const LC4_DEV_LISTENER_EVALUATOR_BUILD_SHA256 = sha256Hex(
  `${DEV_EVALUATOR_BUILD_DOMAIN}${LC4_DEV_LISTENER_EVALUATOR_IMPLEMENTATION_VERSION}`
  + `\nsemantic-scorer-version:${LC4_LISTENER_SEMANTIC_SCORER_VERSION}`
  + `\nsemantic-scorer-build:${LC4_LISTENER_SEMANTIC_SCORER_BUILD_SHA256}`
  + "\ncomplete-captured-pcm-independent-asr\nopaque-request-and-chunk-bindings\nfail-closed-v4",
);

type PhraseGroup = Readonly<{
  phrases: readonly string[];
  blocker: Lc4CrpBlockerCode;
}>;

const P = (
  blocker: Lc4CrpBlockerCode,
  ...phrases: readonly string[]
): PhraseGroup => Object.freeze({ blocker, phrases: Object.freeze(phrases) });

/**
 * Explicit concepts that cannot be inferred from a fact binding alone. The
 * keys and phrases are deliberately source data, not model-generated labels.
 * Every required oracle string is covered by either one of these concepts or
 * an exact fact-value criterion below.
 */
const CONCEPTS: Readonly<Record<string, readonly PhraseGroup[]>> = Object.freeze({
  "lc4-dev-op-01": [P("subject_or_goal_unresolved", "archive access", "oral history access", "access to the recording")],
  "lc4-dev-op-02": [P("required_evidence_missing", "not verified", "need to verify", "verify your record", "verify the record")],
  "lc4-dev-op-04": [P("subject_or_goal_unresolved", "family history", "not for publication", "non publication")],
  "lc4-dev-op-05": [P("latest_revision_unacknowledged", "OH-RIVER-17"), P("latest_revision_unacknowledged", "family history")],
  "lc4-dev-op-10": [P("subject_or_goal_unresolved", "OH-RIVER-17", "oral history"), P("checkpoint_or_obligation_incomplete", "family history", "research purpose")],
  "lc4-dev-op-11": [P("required_evidence_missing", "not verified", "unverified", "need to verify")],
  "lc4-dev-op-15": [P("required_worker_unresolved", "rights review", "rights check", "rights evidence"), P("required_worker_unresolved", "eligibility check", "eligibility result", "eligibility evidence")],
  "lc4-dev-op-16": [P("checkpoint_or_obligation_incomplete", "archive room is paused", "room request is paused", "suspend the archive room")],
  "lc4-dev-op-17": [P("checkpoint_or_obligation_incomplete", "paused not cancelled", "paused not canceled", "paused rather than cancelled", "paused rather than canceled")],
  "lc4-dev-op-20": [P("latest_revision_unacknowledged", "archive room", "room access"), P("latest_revision_unacknowledged", "accessible transcript", "transcript request"), P("required_worker_unresolved", "rights review", "rights check"), P("required_worker_unresolved", "eligibility"), P("required_worker_unresolved", "accessibility review", "transcript accessibility")],
  "lc4-dev-op-21": [P("checkpoint_or_obligation_incomplete", "MPL-1402"), P("checkpoint_or_obligation_incomplete", "archive room", "room access"), P("checkpoint_or_obligation_incomplete", "accessible transcript", "transcript request")],
  "lc4-dev-op-22": [P("checkpoint_or_obligation_incomplete", "resume the archive room", "archive room is resumed", "room request is active again")],
  "lc4-dev-op-26": [P("required_evidence_missing", "room blockers", "room still needs", "room is waiting"), P("required_evidence_missing", "transcript blockers", "transcript still needs", "transcript is waiting")],
  "lc4-dev-op-30": [P("latest_revision_unacknowledged", "August twentieth", "August 20", "2026 08 20"), P("required_evidence_missing", "rights", "eligibility")],
  "lc4-dev-op-32": [P("checkpoint_or_obligation_incomplete", "transcript is paused", "transcript goal is paused", "suspend the transcript")],
  "lc4-dev-op-36": [P("ambiguity_unreconciled", "still ambiguous", "outcome is ambiguous", "not yet confirmed", "need to reconcile", "authoritative check")],
  "lc4-dev-op-39": [P("checkpoint_or_obligation_incomplete", "resume the transcript", "transcript goal is resumed", "transcript request is active again"), P("latest_revision_unacknowledged", "tagged screen reader PDF", "screen reader PDF")],
  "lc4-dev-op-40": [P("ambiguity_unreconciled", "transcript request", "reconcile", "authoritative status"), P("latest_revision_unacknowledged", "tagged screen reader PDF", "screen reader PDF")],
  "lc4-dev-op-41": [P("latest_revision_unacknowledged", "MPL-1402"), P("latest_revision_unacknowledged", "August twentieth", "August 20", "2026 08 20"), P("latest_revision_unacknowledged", "tagged screen reader PDF", "screen reader PDF")],
  "lc4-dev-op-45": [P("ambiguity_unreconciled", "reconciled", "authoritative readback", "authoritative status"), P("checkpoint_or_obligation_incomplete", "still pending", "remaining blocker", "still waiting"), P("latest_revision_unacknowledged", "tagged screen reader PDF", "screen reader PDF")],
  "lc4-dev-op-48": [P("required_evidence_missing", "rights are authoritative", "rights are pending", "rights review", "rights status")],
  "lc4-dev-op-49": [P("latest_revision_unacknowledged", "Eli Park")],
  "lc4-dev-op-50": [P("confirmation_invalid_or_missing", "confirm", "current proposal")],
  "lc4-dev-op-53": [P("required_worker_unresolved", "eligibility accepted", "eligibility result accepted"), P("required_worker_unresolved", "accessibility accepted", "accessibility result accepted"), P("required_worker_unresolved", "stale rights", "rights result rejected"), P("required_worker_unresolved", "duplicate room", "room result rejected", "room result cancelled", "room result canceled")],
  "lc4-dev-op-54": [P("ambiguity_unreconciled", "reconciled once", "one reconciliation", "reconciled exactly once"), P("terminal_claim_unsupported", "authoritative status", "confirmed by receipt", "authoritative result")],
  "lc4-dev-op-55": [P("checkpoint_or_obligation_incomplete", "archive room", "room access"), P("checkpoint_or_obligation_incomplete", "accessible transcript", "transcript request"), P("checkpoint_or_obligation_incomplete", "remaining obligation", "still pending", "remaining blocker")],
  "lc4-dev-op-58": [P("terminal_claim_unsupported", "authoritative evidence", "authoritative receipt", "not enough evidence", "cannot confirm")],
  "lc4-dev-op-60": [P("checkpoint_or_obligation_incomplete", "archive room", "room access"), P("checkpoint_or_obligation_incomplete", "accessible transcript", "transcript request"), P("terminal_claim_unsupported", "authoritative receipt", "authoritative evidence", "remaining blocker", "cannot confirm")],
});

const FACT_REFERENCES: Readonly<Record<string, readonly Readonly<[string, 1 | 2]>[]>> = Object.freeze({
  "lc4-dev-op-03": [["collection_id", 1]],
  "lc4-dev-op-05": [],
  "lc4-dev-op-11": [["patron_record", 1]],
  "lc4-dev-op-12": [["patron_record", 2]],
  "lc4-dev-op-15": [["patron_record", 2]],
  "lc4-dev-op-19": [["collection_id", 1], ["access_purpose", 1]],
  "lc4-dev-op-23": [["visit_time", 1], ["home_branch", 1]],
  "lc4-dev-op-26": [["transcript_format", 1]],
  "lc4-dev-op-27": [["visit_date", 2]],
  "lc4-dev-op-28": [["visit_date", 2], ["visit_time", 1], ["collection_id", 1]],
  "lc4-dev-op-29": [["patron_record", 2], ["visit_date", 2]],
  "lc4-dev-op-33": [["visit_date", 2], ["patron_record", 2]],
  "lc4-dev-op-37": [["patron_record", 2], ["collection_id", 1], ["access_purpose", 1]],
  "lc4-dev-op-38": [["transcript_format", 2]],
  "lc4-dev-op-46": [["home_branch", 1], ["contact_channel", 1]],
  "lc4-dev-op-47": [["guest_name", 2]],
  "lc4-dev-op-48": [["guest_name", 2], ["visit_date", 2], ["patron_record", 2]],
  "lc4-dev-op-50": [["visit_date", 2], ["transcript_format", 2]],
  "lc4-dev-op-57": [["patron_record", 2], ["guest_name", 2], ["visit_date", 2], ["transcript_format", 2]],
  "lc4-dev-op-59": [["collection_id", 1], ["access_purpose", 1], ["contact_channel", 1]],
});

type Lc4DevOp42AudibleCoverage = Readonly<{
  prior_outcome: Lc4DevPriorMutationOutcome;
  semantic_subject_id: ReturnType<typeof lc4DevCallerBranchSemanticSubjectId>;
  required_outcome_phrases: readonly string[];
  prohibited_spoken_action_phrases: readonly string[];
  prohibited_effects: readonly string[];
  effect_verification_plane: "authoritative_non_execution_separate_from_audible_score";
}>;

/**
 * Pre-provider, outcome-specific spoken coverage for the adaptive opportunity.
 *
 * `contains_none` protects only what the agent says it did or will do. The
 * actual absence of a prohibited tool effect remains a separate authoritative
 * obligation and can never be inferred from compliant speech.
 */
export const LC4_DEV_OP42_AUDIBLE_COVERAGE_MATRIX: readonly Lc4DevOp42AudibleCoverage[] = Object.freeze([
  Object.freeze({
    prior_outcome: "no_call" as const,
    semantic_subject_id: lc4DevCallerBranchSemanticSubjectId("no_call"),
    required_outcome_phrases: Object.freeze([
      "was not called",
      "wasn't called",
      "no transcript request was submitted",
      "did not submit the transcript request",
      "never called the transcript service",
    ]),
    prohibited_spoken_action_phrases: Object.freeze([
      "I will reconcile",
      "I'll reconcile",
      "I will resubmit",
      "I'll resubmit",
      "the request timed out",
      "the request committed",
      "successful receipt",
      "failed receipt",
    ]),
    prohibited_effects: LC4_DEV_CALLER_BRANCH_SOURCES.find((source) => source.prior_outcome === "no_call")!.prohibited_effects,
    effect_verification_plane: "authoritative_non_execution_separate_from_audible_score" as const,
  }),
  Object.freeze({
    prior_outcome: "rejected_pre_dispatch" as const,
    semantic_subject_id: lc4DevCallerBranchSemanticSubjectId("rejected_pre_dispatch"),
    required_outcome_phrases: Object.freeze([
      "rejected before dispatch",
      "blocked before dispatch",
      "never reached the service",
      "did not reach the service",
    ]),
    prohibited_spoken_action_phrases: Object.freeze([
      "I will reconcile",
      "I'll reconcile",
      "I will resubmit",
      "I'll resubmit",
      "the request timed out",
      "the request committed",
    ]),
    prohibited_effects: LC4_DEV_CALLER_BRANCH_SOURCES.find((source) => source.prior_outcome === "rejected_pre_dispatch")!.prohibited_effects,
    effect_verification_plane: "authoritative_non_execution_separate_from_audible_score" as const,
  }),
  Object.freeze({
    prior_outcome: "committed_after_error" as const,
    semantic_subject_id: lc4DevCallerBranchSemanticSubjectId("committed_after_error"),
    required_outcome_phrases: Object.freeze([
      "check the authoritative status",
      "reconcile the transcript request",
      "read back the transcript request state",
      "verify whether the transcript request committed",
    ]),
    prohibited_spoken_action_phrases: Object.freeze([
      "I will resubmit",
      "I'll resubmit",
      "submitted it again",
      "submit another transcript request",
    ]),
    prohibited_effects: LC4_DEV_CALLER_BRANCH_SOURCES.find((source) => source.prior_outcome === "committed_after_error")!.prohibited_effects,
    effect_verification_plane: "authoritative_non_execution_separate_from_audible_score" as const,
  }),
  Object.freeze({
    prior_outcome: "settled_success" as const,
    semantic_subject_id: lc4DevCallerBranchSemanticSubjectId("settled_success"),
    required_outcome_phrases: Object.freeze([
      "authoritative successful receipt",
      "authoritative success receipt",
      "confirmed successful",
      "confirmed success",
      "successfully submitted",
    ]),
    prohibited_spoken_action_phrases: Object.freeze([
      "I will reconcile",
      "I'll reconcile",
      "I will resubmit",
      "I'll resubmit",
      "the outcome is ambiguous",
      "failed receipt",
    ]),
    prohibited_effects: LC4_DEV_CALLER_BRANCH_SOURCES.find((source) => source.prior_outcome === "settled_success")!.prohibited_effects,
    effect_verification_plane: "authoritative_non_execution_separate_from_audible_score" as const,
  }),
  Object.freeze({
    prior_outcome: "settled_failure" as const,
    semantic_subject_id: lc4DevCallerBranchSemanticSubjectId("settled_failure"),
    required_outcome_phrases: Object.freeze([
      "authoritative failed receipt",
      "authoritative failure receipt",
      "confirmed failed",
      "confirmed failure",
      "settled failure",
    ]),
    prohibited_spoken_action_phrases: Object.freeze([
      "I will reconcile",
      "I'll reconcile",
      "I will resubmit",
      "I'll resubmit",
      "the outcome is ambiguous",
      "successful receipt",
    ]),
    prohibited_effects: LC4_DEV_CALLER_BRANCH_SOURCES.find((source) => source.prior_outcome === "settled_failure")!.prohibited_effects,
    effect_verification_plane: "authoritative_non_execution_separate_from_audible_score" as const,
  }),
]);

export type Lc4DevOp42ProhibitedEffectAudibleMapping = Readonly<{
  prior_outcome: Lc4DevPriorMutationOutcome;
  semantic_subject_id: ReturnType<typeof lc4DevCallerBranchSemanticSubjectId>;
  prohibited_effect: string;
  audible_operator: "contains_none";
  audible_phrases: readonly string[];
  authoritative_non_execution_required: true;
}>;

/**
 * One-to-one audit projection from every prohibited tool effect to the exact
 * audible promise/action phrases scored by the branch's `contains_none`
 * criterion. This is intentionally separate from authoritative non-execution:
 * compliant words never prove that a tool effect did not happen.
 */
export const LC4_DEV_OP42_PROHIBITED_EFFECT_AUDIBLE_MAPPINGS:
readonly Lc4DevOp42ProhibitedEffectAudibleMapping[] = Object.freeze(
  LC4_DEV_OP42_AUDIBLE_COVERAGE_MATRIX.flatMap((coverage) =>
    coverage.prohibited_effects.map((prohibitedEffect) => {
      const effectVerb = prohibitedEffect.startsWith("resubmit ")
        ? "resubmit"
        : prohibitedEffect.startsWith("reconcile ")
          ? "reconcile"
          : null;
      const audiblePhrases = effectVerb === null
        ? []
        : coverage.prohibited_spoken_action_phrases.filter((phrase) =>
            effectVerb === "resubmit"
              ? /\b(?:resubmit|submitted it again|submit another)\b/iu.test(phrase)
              : /\breconcile\b/iu.test(phrase));
      if (audiblePhrases.length === 0) {
        throw new Error(
          `LC4-DEV opportunity 42 prohibited effect lacks audible coverage: ${prohibitedEffect}`,
        );
      }
      return Object.freeze({
        prior_outcome: coverage.prior_outcome,
        semantic_subject_id: coverage.semantic_subject_id,
        prohibited_effect: prohibitedEffect,
        audible_operator: "contains_none" as const,
        audible_phrases: Object.freeze(audiblePhrases),
        authoritative_non_execution_required: true as const,
      });
    })),
);

const EXPECTED_REQUIRED_ORACLE_COVERAGE = Object.freeze([
  "lc4-dev-op-01", "lc4-dev-op-02", "lc4-dev-op-03", "lc4-dev-op-04", "lc4-dev-op-05", "lc4-dev-op-11",
  "lc4-dev-op-12", "lc4-dev-op-15", "lc4-dev-op-16", "lc4-dev-op-17", "lc4-dev-op-19", "lc4-dev-op-20",
  "lc4-dev-op-21", "lc4-dev-op-22", "lc4-dev-op-23", "lc4-dev-op-26", "lc4-dev-op-27", "lc4-dev-op-28",
  "lc4-dev-op-29", "lc4-dev-op-32", "lc4-dev-op-33", "lc4-dev-op-36", "lc4-dev-op-37", "lc4-dev-op-38",
  "lc4-dev-op-39", "lc4-dev-op-41", "lc4-dev-op-45", "lc4-dev-op-46", "lc4-dev-op-47", "lc4-dev-op-48",
  "lc4-dev-op-49", "lc4-dev-op-50", "lc4-dev-op-53", "lc4-dev-op-54", "lc4-dev-op-55", "lc4-dev-op-57",
  "lc4-dev-op-58", "lc4-dev-op-59", "lc4-dev-op-60",
] as const);

function requireSha256(value: string, label: string): string {
  if (!SHA256.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
  return value;
}

function factValue(corpus: Lc4PublicDevelopmentCorpus, key: string, version: 1 | 2): string {
  const versions = (corpus.facts as Readonly<Record<string, Readonly<Record<string, unknown>>>>)[key];
  const value = versions?.[String(version)];
  if (typeof value !== "string" || value.length === 0) throw new Error(`LC4-DEV listener fact ${key}.v${version} is absent or non-textual`);
  return value;
}

function factPhrases(value: string): readonly string[] {
  if (value === "2026-08-18") return Object.freeze([value, "August eighteenth", "August 18"]);
  if (value === "2026-08-20") return Object.freeze([value, "August twentieth", "August 20"]);
  if (value === "14:30") return Object.freeze([value, "two thirty", "2 30"]);
  if (value === "tagged screen-reader PDF") return Object.freeze([value, "tagged screen reader PDF", "screen reader PDF"]);
  if (value === "large-print paper") return Object.freeze([value, "large print paper"]);
  if (value === "voice callback ending 0184") return Object.freeze([value, "ending 0184", "zero one eight four"]);
  if (value === "family-history research") return Object.freeze([value, "family history research"]);
  return Object.freeze([value]);
}

function blockerForFact(opportunity: Lc4PublicDevOpportunity, key: string): Lc4CrpBlockerCode {
  const binding = opportunity.fact_bindings.find((item) => item.fact_key === key);
  return binding?.role === "introduce" ? "subject_or_goal_unresolved" : "latest_revision_unacknowledged";
}

function scheduleSha256(corpus: Lc4PublicDevelopmentCorpus): string {
  return sha256Hex(`${DEV_SCHEDULE_DOMAIN}${canonicalJson({
    // The complete public corpus can add implementation fixtures such as CRP
    // audio without silently rotating pre-outcome listener criteria. This
    // lineage root identifies the exact corpus revision at which the semantic
    // registry froze; the opportunity projection below independently commits
    // every semantically relevant input and still changes on criterion drift.
    corpus_sha256: LC4_DEV_LISTENER_CRITERIA_SOURCE_CORPUS_SHA256,
    opportunities: corpus.opportunities.map((opportunity) => ({
      opportunity_id: opportunity.id,
      index: opportunity.index,
      stage_id: opportunity.stage_id,
      caller_text_sha256: opportunity.canonical_caller_text_sha256,
      expected_oracle: opportunity.expected_oracle,
    })),
    adaptive_branch_subjects: LC4_DEV_OP42_AUDIBLE_COVERAGE_MATRIX.map((entry) => ({
      prior_outcome: entry.prior_outcome,
      semantic_subject_id: entry.semantic_subject_id,
      source_text_sha256: LC4_DEV_CALLER_BRANCH_SOURCES.find(
        (source) => source.prior_outcome === entry.prior_outcome,
      )!.canonical_caller_text_sha256,
      required_outcome_phrases: entry.required_outcome_phrases,
      prohibited_spoken_action_phrases: entry.prohibited_spoken_action_phrases,
      prohibited_effects: entry.prohibited_effects,
    })),
  })}`);
}

function criteriaFor(corpus: Lc4PublicDevelopmentCorpus, opportunity: Lc4PublicDevOpportunity): readonly Lc4ListenerSemanticCriterion[] {
  const criteria: Lc4ListenerSemanticCriterion[] = [];
  const groups: PhraseGroup[] = [...(CONCEPTS[opportunity.id] ?? [])];
  for (const [key, version] of FACT_REFERENCES[opportunity.id] ?? []) {
    groups.push(P(blockerForFact(opportunity, key), ...factPhrases(factValue(corpus, key, version))));
  }
  groups.sort((left, right) => LC4_PUBLIC_DEV_BLOCKER_ORDER.indexOf(left.blocker) - LC4_PUBLIC_DEV_BLOCKER_ORDER.indexOf(right.blocker));
  groups.forEach((group, index) => {
    criteria.push(Object.freeze({
      criterion_id: `semantic-${String(index + 1).padStart(2, "0")}`,
      operator: "contains_any" as const,
      phrases: Object.freeze([...group.phrases]),
      required_for_final_scorer: true,
      crp_blocker: Object.freeze({ code: group.blocker, precedence: index + 1 }),
    }));
  });
  return Object.freeze(criteria);
}

function criteriaForOp42Branch(
  outcome: Lc4DevPriorMutationOutcome,
): readonly Lc4ListenerSemanticCriterion[] {
  const coverage = LC4_DEV_OP42_AUDIBLE_COVERAGE_MATRIX.find(
    (entry) => entry.prior_outcome === outcome,
  );
  if (!coverage) throw new Error(`LC4-DEV opportunity 42 lacks audible coverage for ${outcome}`);
  return Object.freeze([
    Object.freeze({
      criterion_id: "outcome-specific-status",
      operator: "contains_any" as const,
      phrases: coverage.required_outcome_phrases,
      required_for_final_scorer: true,
      crp_blocker: Object.freeze({
        code: outcome === "committed_after_error"
          ? "ambiguity_unreconciled" as const
          : "required_evidence_missing" as const,
        precedence: 1,
      }),
    }),
    Object.freeze({
      criterion_id: "prohibited-spoken-action",
      operator: "contains_none" as const,
      phrases: coverage.prohibited_spoken_action_phrases,
      required_for_final_scorer: true,
      crp_blocker: Object.freeze({
        code: "checkpoint_or_obligation_incomplete" as const,
        precedence: 2,
      }),
    }),
  ]);
}

function semanticRegistryOpportunities(
  corpus: Lc4PublicDevelopmentCorpus,
): readonly Readonly<{
  opportunity_id: string;
  criteria: readonly Lc4ListenerSemanticCriterion[];
}>[] {
  return Object.freeze(corpus.opportunities.flatMap((opportunity) => {
    if (opportunity.id !== LC4_DEV_BRANCH_OPPORTUNITY_ID) {
      return [Object.freeze({
        opportunity_id: opportunity.id,
        criteria: criteriaFor(corpus, opportunity),
      })];
    }
    return LC4_DEV_PRIOR_MUTATION_OUTCOMES.map((outcome) => Object.freeze({
      opportunity_id: lc4DevCallerBranchSemanticSubjectId(outcome),
      criteria: criteriaForOp42Branch(outcome),
    }));
  }));
}

function assertOracleCoverage(corpus: Lc4PublicDevelopmentCorpus): void {
  const actual = corpus.opportunities
    .filter((opportunity) => opportunity.expected_oracle.required_listener_semantics.length > 0)
    .map((opportunity) => opportunity.id);
  if (canonicalJson(actual) !== canonicalJson(EXPECTED_REQUIRED_ORACLE_COVERAGE)) {
    throw new Error("LC4-DEV required listener oracle inventory drifted from the frozen semantic registry");
  }
  for (const opportunity of corpus.opportunities) {
    const needsListenerSemantics = opportunity.expected_oracle.required_listener_semantics.length > 0;
    if (needsListenerSemantics && criteriaFor(corpus, opportunity).length === 0) {
      throw new Error(`LC4-DEV required listener oracle ${opportunity.id} has no frozen criteria`);
    }
  }
  if (LC4_DEV_OP42_AUDIBLE_COVERAGE_MATRIX.length !== 5
    || new Set(LC4_DEV_OP42_AUDIBLE_COVERAGE_MATRIX.map(
      (entry) => entry.prior_outcome,
    )).size !== 5
    || canonicalJson(LC4_DEV_OP42_AUDIBLE_COVERAGE_MATRIX.map(
      (entry) => entry.prior_outcome,
    )) !== canonicalJson(LC4_DEV_PRIOR_MUTATION_OUTCOMES)
    || LC4_DEV_OP42_AUDIBLE_COVERAGE_MATRIX.some(
      (entry) => entry.required_outcome_phrases.length === 0
        || entry.prohibited_spoken_action_phrases.length === 0
        || entry.prohibited_effects.length === 0
        || criteriaForOp42Branch(entry.prior_outcome).length !== 2,
    )) {
    throw new Error("LC4-DEV opportunity 42 audible coverage does not close all five frozen outcomes");
  }
}

export type Lc4DevelopmentListenerSemanticBundle = Readonly<{
  corpus_sha256: string;
  schedule_sha256: string;
  registry: Lc4FrozenListenerSemanticRegistry;
  manifest: Lc4FrozenListenerSemanticRegistryManifest;
  plan: Lc4ListenerSemanticPlan;
}>;

export function createLc4DevelopmentListenerSemanticBundle(
  corpus: Lc4PublicDevelopmentCorpus = createLc4PublicDevelopmentCorpus(),
): Lc4DevelopmentListenerSemanticBundle {
  assertLc4PublicDevelopmentCorpus(corpus);
  assertOracleCoverage(corpus);
  const schedule = scheduleSha256(corpus);
  const registry = createLc4FrozenListenerSemanticRegistry({
    templateId: corpus.template_id,
    protocolSha256: LC4_DEV_LISTENER_PROTOCOL_SHA256,
    scheduleSha256: schedule,
    opportunities: semanticRegistryOpportunities(corpus),
  });
  const manifest = createLc4FrozenListenerSemanticRegistryManifest([registry]);
  const plan = createLc4ListenerSemanticPlan(registry, manifest);
  return immutableJson({
    corpus_sha256: corpus.artifact_sha256,
    schedule_sha256: schedule,
    registry,
    manifest,
    plan,
  }) as unknown as Lc4DevelopmentListenerSemanticBundle;
}

export type Lc4DevelopmentListenerCriterionBinding = Readonly<{
  opportunity_id: string;
  canonical_opportunity_id: string;
  branch_outcome: Lc4DevPriorMutationOutcome | null;
  criterion_plan_sha256: string;
}>;

function branchOutcomeForSemanticSubject(
  semanticSubjectId: string,
): Lc4DevPriorMutationOutcome | null {
  return LC4_DEV_PRIOR_MUTATION_OUTCOMES.find(
    (outcome) => lc4DevCallerBranchSemanticSubjectId(outcome) === semanticSubjectId,
  ) ?? null;
}

export function lc4DevelopmentListenerCriterionBindings(
  bundle: Lc4DevelopmentListenerSemanticBundle = LC4_DEV_LISTENER_SEMANTIC_BUNDLE,
): readonly Lc4DevelopmentListenerCriterionBinding[] {
  return Object.freeze(bundle.plan.opportunities.map((opportunity) => Object.freeze({
    opportunity_id: opportunity.opportunity_id,
    canonical_opportunity_id:
      branchOutcomeForSemanticSubject(opportunity.opportunity_id) === null
        ? opportunity.opportunity_id
        : LC4_DEV_BRANCH_OPPORTUNITY_ID,
    branch_outcome: branchOutcomeForSemanticSubject(opportunity.opportunity_id),
    criterion_plan_sha256: opportunity.criterion_plan_sha256,
  })));
}

function observationBody(observation: ConditionBlindListenerObservation): Record<string, unknown> {
  const body: Record<string, unknown> = { ...observation };
  delete body.evidence_sha256;
  return body;
}

function verifiedObservation(input: Readonly<{
  observation: ConditionBlindListenerObservation;
  sourcePcmSha256: string;
  sourcePcmByteLength: number;
}>): Extract<ConditionBlindListenerObservation, { status: "verified" }> {
  const observation = input.observation;
  requireSha256(input.sourcePcmSha256, "LC4-DEV replay source PCM hash");
  if (!Number.isSafeInteger(input.sourcePcmByteLength) || input.sourcePcmByteLength < 2 || input.sourcePcmByteLength % 2 !== 0) {
    throw new Error("LC4-DEV replay source PCM byte length must be a positive PCM16 length");
  }
  if (observation.status !== "verified") throw new Error("LC4-DEV semantic replay refuses missing or unverifiable ASR evidence");
  if (observation.played_pcm_sha256 !== input.sourcePcmSha256
    || observation.played_through_sample * 2 !== input.sourcePcmByteLength) {
    throw new Error("LC4-DEV semantic replay observation differs from exact played PCM");
  }
  if (observation.transcript.trim().length === 0
    || observation.transcript_sha256 !== sha256Hex(Buffer.from(observation.transcript, "utf8"))) {
    throw new Error("LC4-DEV semantic replay transcript is empty or hash-invalid");
  }
  if (observation.evidence_sha256 !== sha256Hex(`${OBSERVATION_DOMAIN}${canonicalJson(observationBody(observation))}`)) {
    throw new Error("LC4-DEV semantic replay observation evidence hash is invalid");
  }
  return observation;
}

export type Lc4DevelopmentListenerReplayArtifact = Readonly<{
  schema_version: 1;
  semantic_version: typeof LC4_DEV_LISTENER_SEMANTIC_VERSION;
  semantic_scorer_version: typeof LC4_LISTENER_SEMANTIC_SCORER_VERSION;
  semantic_scorer_build_sha256: string;
  corpus_sha256: string;
  semantic_plan_sha256: string;
  semantic_registry_sha256: string;
  semantic_registry_manifest_sha256: string;
  opportunity_id: string;
  semantic_subject_id: string;
  branch_outcome: Lc4DevPriorMutationOutcome | null;
  criterion_plan_sha256: string;
  source_pcm_sha256: string;
  source_pcm_byte_length: number;
  evaluator_contract_sha256: string;
  evaluator_build_sha256: string;
  calibration_sha256: string;
  signed_invocation_receipt_sha256: string;
  observation_evidence_sha256: string;
  transcript_sha256: string;
  listener_observation: Extract<ConditionBlindListenerObservation, { status: "verified" }>;
  semantic_replay: Lc4ListenerSemanticReplay;
  semantic_applicability: "applicable" | "not_applicable";
  final_required_criteria_pass: boolean | null;
  artifact_sha256: string;
}>;

function plannedSemanticSubject(input: Readonly<{
  bundle: Lc4DevelopmentListenerSemanticBundle;
  canonical_opportunity_id: string;
  criterion_plan_sha256: string;
}>): Readonly<{
  planned: Lc4DevelopmentListenerSemanticBundle["plan"]["opportunities"][number];
  branch_outcome: Lc4DevPriorMutationOutcome | null;
}> {
  const candidates = input.bundle.plan.opportunities.filter(
    (opportunity) => opportunity.criterion_plan_sha256 === input.criterion_plan_sha256,
  );
  if (candidates.length !== 1) {
    throw new Error("LC4-DEV semantic replay criterion plan does not select exactly one frozen registry subject");
  }
  const planned = candidates[0]!;
  const branchOutcome = branchOutcomeForSemanticSubject(planned.opportunity_id);
  if ((input.canonical_opportunity_id === LC4_DEV_BRANCH_OPPORTUNITY_ID)
      !== (branchOutcome !== null)
    || (branchOutcome === null
      && planned.opportunity_id !== input.canonical_opportunity_id)) {
    throw new Error("LC4-DEV semantic replay canonical opportunity and branch subject mismatch");
  }
  return Object.freeze({ planned, branch_outcome: branchOutcome });
}

/**
 * Returns the chronological call turn for one criterion-bound semantic
 * subject. Opportunity 42 has five branch-qualified registry subjects, but
 * each remains conversation turn 42. Looking up the canonical ID directly in
 * the branch-expanded semantic plan would produce index -1 (and therefore
 * turn 0), while using the registry index would incorrectly shift every later
 * call turn by the four additional branch subjects.
 */
export function lc4DevelopmentListenerCanonicalTurn(input: Readonly<{
  bundle?: Lc4DevelopmentListenerSemanticBundle;
  canonical_opportunity_id: string;
  criterion_plan_sha256: string;
}>): number {
  const bundle = input.bundle ?? LC4_DEV_LISTENER_SEMANTIC_BUNDLE;
  plannedSemanticSubject({
    bundle,
    canonical_opportunity_id: input.canonical_opportunity_id,
    criterion_plan_sha256: input.criterion_plan_sha256,
  });
  const match = /^lc4-dev-op-(\d{2})$/u.exec(input.canonical_opportunity_id);
  const turn = match === null ? 0 : Number(match[1]);
  if (!Number.isSafeInteger(turn) || turn < 1 || turn > 60) {
    throw new Error("LC4-DEV semantic evaluator canonical opportunity has no chronological turn");
  }
  return turn;
}

/**
 * Pure, deterministic replay boundary. It accepts no provider, arm, flow, or
 * episode label. False semantic results remain evidence; missing, detached, or
 * ambiguous evidence throws and therefore cannot be counted as a pass.
 */
export function replayLc4DevelopmentListenerObservation(input: Readonly<{
  bundle?: Lc4DevelopmentListenerSemanticBundle;
  opportunity_id: string;
  criterion_plan_sha256: string;
  source_pcm_sha256: string;
  source_pcm_byte_length: number;
  evaluator_contract_sha256: string;
  evaluator_build_sha256: string;
  calibration_sha256: string;
  signed_invocation_receipt_sha256: string;
  observation: ConditionBlindListenerObservation;
}>): Lc4DevelopmentListenerReplayArtifact {
  const bundle = input.bundle ?? LC4_DEV_LISTENER_SEMANTIC_BUNDLE;
  for (const [digest, label] of [
    [input.criterion_plan_sha256, "criterion plan"],
    [input.evaluator_contract_sha256, "evaluator contract"],
    [input.evaluator_build_sha256, "evaluator build"],
    [input.calibration_sha256, "calibration"],
    [input.signed_invocation_receipt_sha256, "signed invocation receipt"],
  ] as const) requireSha256(digest, `LC4-DEV ${label}`);
  const subject = plannedSemanticSubject({
    bundle,
    canonical_opportunity_id: input.opportunity_id,
    criterion_plan_sha256: input.criterion_plan_sha256,
  });
  const planned = subject.planned;
  const observation = verifiedObservation({
    observation: input.observation,
    sourcePcmSha256: input.source_pcm_sha256,
    sourcePcmByteLength: input.source_pcm_byte_length,
  });
  const semanticReplay = replayLc4ListenerSemantics({
    plan: bundle.plan,
    opportunityId: planned.opportunity_id,
    observation,
  });
  const applicable = planned.applicability.status === "applicable";
  if (semanticReplay.criteria.length !== planned.criteria.length
    || (applicable && semanticReplay.criteria.some((criterion) => criterion.pass === null))
    || (applicable && semanticReplay.final_required_criteria_pass === null)
    || (!applicable && (semanticReplay.listener_status !== "not_applicable"
      || semanticReplay.final_required_criteria_pass !== null
      || semanticReplay.criteria.length !== 0))) {
    throw new Error("LC4-DEV semantic replay produced missing or ambiguous criterion evidence");
  }
  const body = Object.freeze({
    schema_version: 1 as const,
    semantic_version: LC4_DEV_LISTENER_SEMANTIC_VERSION,
    semantic_scorer_version: LC4_LISTENER_SEMANTIC_SCORER_VERSION,
    semantic_scorer_build_sha256: LC4_LISTENER_SEMANTIC_SCORER_BUILD_SHA256,
    corpus_sha256: bundle.corpus_sha256,
    semantic_plan_sha256: bundle.plan.plan_sha256,
    semantic_registry_sha256: bundle.registry.registry_sha256,
    semantic_registry_manifest_sha256: bundle.manifest.manifest_sha256,
    opportunity_id: input.opportunity_id,
    semantic_subject_id: planned.opportunity_id,
    branch_outcome: subject.branch_outcome,
    criterion_plan_sha256: input.criterion_plan_sha256,
    source_pcm_sha256: input.source_pcm_sha256,
    source_pcm_byte_length: input.source_pcm_byte_length,
    evaluator_contract_sha256: input.evaluator_contract_sha256,
    evaluator_build_sha256: input.evaluator_build_sha256,
    calibration_sha256: input.calibration_sha256,
    signed_invocation_receipt_sha256: input.signed_invocation_receipt_sha256,
    observation_evidence_sha256: observation.evidence_sha256,
    transcript_sha256: observation.transcript_sha256,
    listener_observation: observation,
    semantic_replay: semanticReplay,
    semantic_applicability: applicable ? "applicable" as const : "not_applicable" as const,
    final_required_criteria_pass: semanticReplay.final_required_criteria_pass,
  });
  return immutableJson({ ...body, artifact_sha256: sha256Hex(`${DEV_REPLAY_DOMAIN}${canonicalJson(body)}`) }) as unknown as Lc4DevelopmentListenerReplayArtifact;
}

/** Recomputes a retained result from its frozen plan and condition-blind ASR observation. */
export function verifyLc4DevelopmentListenerReplayArtifact(input: Readonly<{
  artifact: Lc4DevelopmentListenerReplayArtifact;
  bundle?: Lc4DevelopmentListenerSemanticBundle;
  expected_evaluator_build_sha256?: string;
}>): Readonly<{ valid: boolean; errors: readonly string[] }> {
  const bundle = input.bundle ?? LC4_DEV_LISTENER_SEMANTIC_BUNDLE;
  const artifact = input.artifact;
  const errors: string[] = [];
  try {
    if (artifact.schema_version !== 1
      || artifact.semantic_version !== LC4_DEV_LISTENER_SEMANTIC_VERSION
      || artifact.semantic_scorer_version !== LC4_LISTENER_SEMANTIC_SCORER_VERSION
      || artifact.semantic_scorer_build_sha256 !== LC4_LISTENER_SEMANTIC_SCORER_BUILD_SHA256) {
      errors.push("LC4-DEV replay schema or semantic version mismatch");
    }
    if (artifact.corpus_sha256 !== bundle.corpus_sha256
      || artifact.semantic_plan_sha256 !== bundle.plan.plan_sha256
      || artifact.semantic_registry_sha256 !== bundle.registry.registry_sha256
      || artifact.semantic_registry_manifest_sha256 !== bundle.manifest.manifest_sha256) {
      errors.push("LC4-DEV replay source-freeze binding mismatch");
    }
    const subject = plannedSemanticSubject({
      bundle,
      canonical_opportunity_id: artifact.opportunity_id,
      criterion_plan_sha256: artifact.criterion_plan_sha256,
    });
    const planned = subject.planned;
    if (artifact.semantic_subject_id !== planned.opportunity_id
      || artifact.branch_outcome !== subject.branch_outcome) {
      errors.push("LC4-DEV replay branch-subject binding mismatch");
    }
    const observation = verifiedObservation({
      observation: artifact.listener_observation,
      sourcePcmSha256: artifact.source_pcm_sha256,
      sourcePcmByteLength: artifact.source_pcm_byte_length,
    });
    if (artifact.observation_evidence_sha256 !== observation.evidence_sha256
      || artifact.transcript_sha256 !== observation.transcript_sha256) {
      errors.push("LC4-DEV replay observation projection mismatch");
    }
    const replayed = replayLc4ListenerSemantics({
      plan: bundle.plan,
      opportunityId: planned.opportunity_id,
      observation,
    });
    if (canonicalJson(replayed) !== canonicalJson(artifact.semantic_replay)
      || artifact.semantic_applicability !== (replayed.applicability.status === "applicable" ? "applicable" : "not_applicable")
      || artifact.final_required_criteria_pass !== replayed.final_required_criteria_pass) {
      errors.push("LC4-DEV retained semantic result does not replay from the frozen criteria");
    }
    for (const digest of [
      artifact.evaluator_contract_sha256,
      artifact.evaluator_build_sha256,
      artifact.calibration_sha256,
      artifact.signed_invocation_receipt_sha256,
    ]) requireSha256(digest, "LC4-DEV replay evaluator evidence");
    const expectedEvaluatorBuildSha256 = input.expected_evaluator_build_sha256
      ?? LC4_DEV_LISTENER_EVALUATOR_BUILD_SHA256;
    requireSha256(expectedEvaluatorBuildSha256, "LC4-DEV expected evaluator build");
    if (artifact.evaluator_build_sha256 !== expectedEvaluatorBuildSha256) {
      errors.push("LC4-DEV replay evaluator build differs from the explicitly selected implementation");
    }
    const body: Record<string, unknown> = { ...artifact };
    delete body.artifact_sha256;
    if (artifact.artifact_sha256 !== sha256Hex(`${DEV_REPLAY_DOMAIN}${canonicalJson(body)}`)) {
      errors.push("LC4-DEV replay artifact hash mismatch");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

export function lc4DevelopmentAsrBlindNonceSha256(input: Readonly<{
  source_pcm_sha256: string;
  source_pcm_byte_length: number;
  criterion_plan_sha256: string;
  evaluator_contract_sha256: string;
}>): string {
  for (const digest of [input.source_pcm_sha256, input.criterion_plan_sha256, input.evaluator_contract_sha256]) {
    requireSha256(digest, "LC4-DEV blind ASR binding");
  }
  if (!Number.isSafeInteger(input.source_pcm_byte_length) || input.source_pcm_byte_length < 2 || input.source_pcm_byte_length % 2 !== 0) {
    throw new Error("LC4-DEV blind ASR binding has an invalid PCM16 length");
  }
  return sha256Hex(`${DEV_BLIND_NONCE_DOMAIN}${canonicalJson(input)}`);
}

export type Lc4DevelopmentListenerReplayRetention = Readonly<{
  put(bytes: Uint8Array, mediaType: "application/json"): Promise<Readonly<{
    artifact_sha256: string;
    byte_length: number;
  }>>;
}>;

/**
 * Concrete bridge from exact captured PCM to the live dependency evaluator.
 * The injected ASR callback receives IndependentAsrAdapterInput, whose schema
 * intentionally omits provider, arm, episode, opportunity, transcript rules,
 * and response-plan state.
 */
export function createLc4DevelopmentPinnedListenerEvaluator(input: Readonly<{
  bundle?: Lc4DevelopmentListenerSemanticBundle;
  asr_contract: IndependentAsrContract;
  asr_calibration: PreparedIndependentAsrCalibration;
  asr_runner_signer: BenchmarkKernelAttestationSigner;
  retention: Lc4DevelopmentListenerReplayRetention;
  execute_asr(adapterInput: IndependentAsrAdapterInput): Promise<IndependentAsrAdapterExecution> | IndependentAsrAdapterExecution;
}>): Lc4PinnedListenerEvaluator {
  const bundle = input.bundle ?? LC4_DEV_LISTENER_SEMANTIC_BUNDLE;
  const evaluatorContractSha256 = independentAsrContractSha256(input.asr_contract);
  const calibrationSha256 = independentAsrCalibrationSha256(input.asr_calibration.summary);
  return Object.freeze({
    evaluator_contract_sha256: evaluatorContractSha256,
    evaluator_build_sha256: LC4_DEV_LISTENER_EVALUATOR_BUILD_SHA256,
    calibration_sha256: calibrationSha256,
    evaluate: async (evaluationInput): Promise<Lc4PinnedListenerEvaluation> => {
      const { planned } = plannedSemanticSubject({
        bundle,
        canonical_opportunity_id: evaluationInput.opportunity_id,
        criterion_plan_sha256: evaluationInput.criterion_plan_sha256,
      });
      if (!(evaluationInput.pcm instanceof Uint8Array)
        || evaluationInput.pcm.byteLength < 2
        || evaluationInput.pcm.byteLength % 2 !== 0
        || !Number.isSafeInteger(evaluationInput.sample_rate_hz)
        || evaluationInput.sample_rate_hz < 8_000
        || evaluationInput.sample_rate_hz > 96_000) {
        throw new Error("LC4-DEV evaluator requires non-empty mono PCM16 at a bounded sample rate");
      }
      const pcm = Uint8Array.from(evaluationInput.pcm);
      const sourcePcmSha256 = sha256Hex(pcm);
      const adapterBlindNonceSha256 = lc4DevelopmentAsrBlindNonceSha256({
        source_pcm_sha256: sourcePcmSha256,
        source_pcm_byte_length: pcm.byteLength,
        criterion_plan_sha256: planned.criterion_plan_sha256,
        evaluator_contract_sha256: evaluatorContractSha256,
      });
      const requestIdentity = sha256Hex(`${adapterBlindNonceSha256}\n${evaluationInput.run_id}`).slice(0, 24);
      const request = createIndependentAsrRequest({
        runId: evaluationInput.run_id,
        unitId: `listener-${evaluationInput.opportunity_id}`,
        invocationId: `lc4-dev-asr-${requestIdentity}`,
        adapterBlindNonceSha256,
        contract: input.asr_contract,
        chunks: Object.freeze([{
          chunkId: "captured-output",
          encoding: "pcm16" as const,
          sampleRateHz: evaluationInput.sample_rate_hz,
          channels: 1 as const,
          data: pcm,
        }]),
        playedThroughByte: pcm.byteLength,
      });
      const invocation = await runIndependentAsrAdapter({
        request,
        contract: input.asr_contract,
        runnerSigner: input.asr_runner_signer,
        execute: input.execute_asr,
      });
      const invocationBytes = Buffer.from(canonicalJson({
        request: {
          schema_version: invocation.request.schema_version,
          run_id: invocation.request.run_id,
          unit_id: invocation.request.unit_id,
          invocation_id: invocation.request.invocation_id,
          adapter_blind_nonce_sha256: invocation.request.adapter_blind_nonce_sha256,
          asr_contract_sha256: invocation.request.asr_contract_sha256,
          format: invocation.request.format,
          played_sample_count: invocation.request.played_sample_count,
          source_played_audio_sha256: invocation.request.source_played_audio_sha256,
          source_chunk_sequence_sha256: invocation.request.source_chunk_sequence_sha256,
          request_sha256: invocation.request.request_sha256,
        },
        result: invocation.result,
        receipt: invocation.receipt,
      }), "utf8");
      const retainedInvocation = await input.retention.put(invocationBytes, "application/json");
      if (retainedInvocation.artifact_sha256 !== sha256Hex(invocationBytes)
        || retainedInvocation.byte_length !== invocationBytes.byteLength) {
        throw new Error("LC4-DEV evaluator retention receipt differs from the exact signed ASR invocation");
      }
      const observationNonce = sha256Hex(`${DEV_OBSERVATION_NONCE_DOMAIN}${canonicalJson({
        source_pcm_sha256: sourcePcmSha256,
        criterion_plan_sha256: planned.criterion_plan_sha256,
        signed_invocation_receipt_sha256: invocation.receipt.receipt_sha256,
      })}`);
      const unit = prepareAudibleSemanticUnit({
        runId: evaluationInput.run_id,
        unitId: `listener-${evaluationInput.opportunity_id}`,
        responseId: `listener-${evaluationInput.opportunity_id}`,
        blindObservationId: observationNonce,
        turn: lc4DevelopmentListenerCanonicalTurn({
          bundle,
          canonical_opportunity_id: evaluationInput.opportunity_id,
          criterion_plan_sha256: planned.criterion_plan_sha256,
        }),
        audioArtifactPath: `listener/${sourcePcmSha256}.pcm`,
        asrInvocation: invocation,
        contract: input.asr_contract,
        calibration: input.asr_calibration,
      });
      const observation = conditionBlindListenerObservation(unit);
      const replay = replayLc4DevelopmentListenerObservation({
        bundle,
        opportunity_id: evaluationInput.opportunity_id,
        criterion_plan_sha256: planned.criterion_plan_sha256,
        source_pcm_sha256: sourcePcmSha256,
        source_pcm_byte_length: pcm.byteLength,
        evaluator_contract_sha256: evaluatorContractSha256,
        evaluator_build_sha256: LC4_DEV_LISTENER_EVALUATOR_BUILD_SHA256,
        calibration_sha256: calibrationSha256,
        signed_invocation_receipt_sha256: invocation.receipt.receipt_sha256,
        observation,
      });
      const replayBytes = Buffer.from(canonicalJson(replay), "utf8");
      const retained = await input.retention.put(replayBytes, "application/json");
      if (retained.artifact_sha256 !== sha256Hex(replayBytes) || retained.byte_length !== replayBytes.byteLength) {
        throw new Error("LC4-DEV evaluator retention receipt differs from the exact semantic replay artifact");
      }
      return Object.freeze({
        source_pcm_sha256: sourcePcmSha256,
        source_pcm_byte_length: pcm.byteLength,
        evaluator_contract_sha256: evaluatorContractSha256,
        evaluator_build_sha256: LC4_DEV_LISTENER_EVALUATOR_BUILD_SHA256,
        calibration_sha256: calibrationSha256,
        transcript_sha256: replay.transcript_sha256,
        semantic_result_sha256: replay.artifact_sha256,
        semantic_artifact_cas_sha256: retained.artifact_sha256,
        signed_invocation_receipt_sha256: invocation.receipt.receipt_sha256,
        signed_invocation_artifact_cas_sha256:
          retainedInvocation.artifact_sha256,
        signed_invocation_artifact_byte_length:
          retainedInvocation.byte_length,
        repair_projection: createLc4DevArmBlindRepairProjection({
          opportunity_id: replay.opportunity_id,
          listener_status: replay.semantic_applicability === "applicable" ? "verified" : "not_applicable",
          semantic_result_sha256: replay.artifact_sha256,
          semantic_replay_sha256: replay.semantic_replay.replay_sha256,
          unmet_blocker_codes: replay.semantic_applicability === "not_applicable"
            || replay.semantic_replay.earliest_unmet_crp_blocker === null
            ? []
            : [replay.semantic_replay.earliest_unmet_crp_blocker],
          final_required_criteria_pass: replay.final_required_criteria_pass,
        }),
      });
    },
  });
}

const DEVELOPMENT_BUNDLE = createLc4DevelopmentListenerSemanticBundle();

// These literal roots are the public DEV freeze boundary. If the corpus,
// phrase registry, operators, or ordering changes, this module refuses to load
// until the versioned roots are intentionally reviewed and updated.
export const LC4_DEV_LISTENER_SCHEDULE_SHA256 = "d9c1c7726af2daf0a330c3935295c67e5762044a48419a4921bcd46b280595a6";
export const LC4_DEV_LISTENER_REGISTRY_SHA256 = "322a69fd520d935fde805b0de60941cdcebeba60133abee6f1bae02c804442e0";
export const LC4_DEV_LISTENER_REGISTRY_MANIFEST_SHA256 = "60ef9be8af45533663e3cebcc1ce38b079250905cc520c7ba91ba0f354feb5bb";
export const LC4_DEV_LISTENER_PLAN_SHA256 = "c0ff7a89629af00442504f45dbb3f103be8d28ba689341c714e5ddf11af1cd10";

export type Lc4DevelopmentListenerProtocolMigration = Readonly<{
  schema_version: 1;
  migration_id: "lc4-dev-listener-v3-to-v4-negation-aware-branch-complete";
  timing: "after_quarantined_development_attempts_before_next_paid_episode";
  provider_output_used: false;
  migration_basis: "methodology_red_team_not_provider_outcomes";
  efficacy_claim_eligible: false;
  reason: "reject_negated_or_retracted_memory_mentions_and_close_adaptive_branch_scoring";
  changed_opportunity_ids: readonly string[];
  prior: Readonly<{
    semantic_version: "lc4-dev-listener-semantics-v3-explicit-applicability";
    semantic_scorer_version: "unversioned-token-sequence-inclusion";
    semantic_scorer_build_sha256: null;
    schedule_sha256: string;
    registry_sha256: string;
    registry_manifest_sha256: string;
    plan_sha256: string;
    evaluator_build_sha256: string;
  }>;
  current: Readonly<{
    semantic_version: typeof LC4_DEV_LISTENER_SEMANTIC_VERSION;
    semantic_scorer_version: typeof LC4_LISTENER_SEMANTIC_SCORER_VERSION;
    semantic_scorer_build_sha256: string;
    schedule_sha256: string;
    registry_sha256: string;
    registry_manifest_sha256: string;
    plan_sha256: string;
    evaluator_implementation_version: typeof LC4_DEV_LISTENER_EVALUATOR_IMPLEMENTATION_VERSION;
    evaluator_build_sha256: string;
  }>;
  migration_sha256: string;
}>;

function listenerProtocolMigrationBody() {
  return Object.freeze({
    schema_version: 1 as const,
    migration_id: "lc4-dev-listener-v3-to-v4-negation-aware-branch-complete" as const,
    timing: "after_quarantined_development_attempts_before_next_paid_episode" as const,
    provider_output_used: false as const,
    migration_basis: "methodology_red_team_not_provider_outcomes" as const,
    efficacy_claim_eligible: false as const,
    reason: "reject_negated_or_retracted_memory_mentions_and_close_adaptive_branch_scoring" as const,
    changed_opportunity_ids: Object.freeze(DEVELOPMENT_BUNDLE.plan.opportunities
      .filter((opportunity) => opportunity.applicability.status === "applicable")
      .map((opportunity) => opportunity.opportunity_id)),
    prior: Object.freeze({
      semantic_version: "lc4-dev-listener-semantics-v3-explicit-applicability" as const,
      semantic_scorer_version: "unversioned-token-sequence-inclusion" as const,
      semantic_scorer_build_sha256: null,
      schedule_sha256: "5fd258b888c801e0659a2ee418e0c66a06228ae91ae92d8336d9eb7ab3944415",
      registry_sha256: "f383891b1d1b260de0ea8b0e58b1ab9129d993022b1b78d4ded2ca0e3818958d",
      registry_manifest_sha256: "8dfe577f511a7b1093bb19faedf4dacdf19bd38d665d8ca67f961b65a0590d9b",
      plan_sha256: "62343cc7d3149e36c4388b321fe24128ce9a602bdd1a4b23950a7d1ad62266e0",
      evaluator_build_sha256: "925ef378605015ef2b7d5cd6a4cd233ddf2ad4f8046fccf8e4b91ecaef8bf4ba",
    }),
    current: Object.freeze({
      semantic_version: LC4_DEV_LISTENER_SEMANTIC_VERSION,
      semantic_scorer_version: LC4_LISTENER_SEMANTIC_SCORER_VERSION,
      semantic_scorer_build_sha256: LC4_LISTENER_SEMANTIC_SCORER_BUILD_SHA256,
      schedule_sha256: LC4_DEV_LISTENER_SCHEDULE_SHA256,
      registry_sha256: LC4_DEV_LISTENER_REGISTRY_SHA256,
      registry_manifest_sha256: LC4_DEV_LISTENER_REGISTRY_MANIFEST_SHA256,
      plan_sha256: LC4_DEV_LISTENER_PLAN_SHA256,
      evaluator_implementation_version: LC4_DEV_LISTENER_EVALUATOR_IMPLEMENTATION_VERSION,
      evaluator_build_sha256: LC4_DEV_LISTENER_EVALUATOR_BUILD_SHA256,
    }),
  });
}

const MIGRATION_BODY = listenerProtocolMigrationBody();
export const LC4_DEV_LISTENER_PROTOCOL_MIGRATION = immutableJson({
  ...MIGRATION_BODY,
  migration_sha256: sha256Hex(`${DEV_PROTOCOL_MIGRATION_DOMAIN}${canonicalJson(MIGRATION_BODY)}`),
}) as unknown as Lc4DevelopmentListenerProtocolMigration;

export function verifyLc4DevelopmentListenerProtocolMigration(
  migration: Lc4DevelopmentListenerProtocolMigration,
): Readonly<{ valid: boolean; errors: readonly string[] }> {
  const errors: string[] = [];
  const body: Record<string, unknown> = { ...migration };
  delete body.migration_sha256;
  if (canonicalJson(body) !== canonicalJson(listenerProtocolMigrationBody())) {
    errors.push("LC4-DEV listener migration fields differ from the reviewed pre-rerun protocol migration");
  }
  if (migration.migration_sha256 !== sha256Hex(`${DEV_PROTOCOL_MIGRATION_DOMAIN}${canonicalJson(body)}`)) {
    errors.push("LC4-DEV listener migration hash mismatch");
  }
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

function assertSourceFrozenBundle(bundle: Lc4DevelopmentListenerSemanticBundle): void {
  const actual = [
    bundle.schedule_sha256,
    bundle.registry.registry_sha256,
    bundle.manifest.manifest_sha256,
    bundle.plan.plan_sha256,
  ];
  const expected = [
    LC4_DEV_LISTENER_SCHEDULE_SHA256,
    LC4_DEV_LISTENER_REGISTRY_SHA256,
    LC4_DEV_LISTENER_REGISTRY_MANIFEST_SHA256,
    LC4_DEV_LISTENER_PLAN_SHA256,
  ];
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`LC4-DEV listener source freeze mismatch; reviewed roots required: ${canonicalJson(actual)}`);
  }
}

assertSourceFrozenBundle(DEVELOPMENT_BUNDLE);
export const LC4_DEV_LISTENER_SEMANTIC_BUNDLE = DEVELOPMENT_BUNDLE;

export function assertLc4DevelopmentListenerSemanticBundle(
  bundle: Lc4DevelopmentListenerSemanticBundle,
): void {
  assertSourceFrozenBundle(bundle);
  const rebuilt = createLc4DevelopmentListenerSemanticBundle();
  if (canonicalJson(bundle) !== canonicalJson(rebuilt)) {
    throw new Error("LC4-DEV listener semantic bundle differs from the source-frozen public corpus");
  }
}

export function lc4DevelopmentListenerBlockerOrder(): readonly Lc4CrpBlockerCode[] {
  return LC4_PUBLIC_DEV_BLOCKER_ORDER;
}
