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
import type {
  Lc4PinnedListenerEvaluation,
  Lc4PinnedListenerEvaluator,
} from "./lc4-development-live-dependencies";
import {
  LC4_PUBLIC_DEV_BLOCKER_ORDER,
  LC4_PUBLIC_DEV_PROTOCOL_ID,
  assertLc4PublicDevelopmentCorpus,
  createLc4PublicDevelopmentCorpus,
  type Lc4PublicDevelopmentCorpus,
  type Lc4PublicDevOpportunity,
} from "./lc4-public-development-corpus";
import {
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

export const LC4_DEV_LISTENER_SEMANTIC_VERSION = "lc4-dev-listener-semantics-v1" as const;
export const LC4_DEV_LISTENER_PROTOCOL_SHA256 = sha256Hex(
  `${DEV_PROTOCOL_DOMAIN}${LC4_PUBLIC_DEV_PROTOCOL_ID}\nplayed-pcm-only\nprovider-arm-blind\nfrozen-before-output`,
);
export const LC4_DEV_LISTENER_EVALUATOR_BUILD_SHA256 = sha256Hex(
  `${DEV_EVALUATOR_BUILD_DOMAIN}nfkc-en-us-tokenization\ncontains-any-all-none-ordered\nexact-pcm-independent-asr\nfail-closed-v1`,
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
  "lc4-dev-op-11": [P("required_evidence_missing", "not verified", "unverified", "need to verify")],
  "lc4-dev-op-15": [P("required_worker_unresolved", "rights review", "rights check", "rights evidence"), P("required_worker_unresolved", "eligibility check", "eligibility result", "eligibility evidence")],
  "lc4-dev-op-16": [P("checkpoint_or_obligation_incomplete", "archive room is paused", "room request is paused", "suspend the archive room")],
  "lc4-dev-op-17": [P("checkpoint_or_obligation_incomplete", "paused not cancelled", "paused not canceled", "paused rather than cancelled", "paused rather than canceled")],
  "lc4-dev-op-20": [P("checkpoint_or_obligation_incomplete", "archive room", "room access"), P("checkpoint_or_obligation_incomplete", "accessible transcript", "transcript request"), P("required_worker_unresolved", "rights review", "rights check"), P("required_worker_unresolved", "eligibility"), P("required_worker_unresolved", "accessibility review", "transcript accessibility")],
  "lc4-dev-op-21": [P("checkpoint_or_obligation_incomplete", "MPL-1402"), P("checkpoint_or_obligation_incomplete", "archive room", "room access"), P("checkpoint_or_obligation_incomplete", "accessible transcript", "transcript request")],
  "lc4-dev-op-22": [P("checkpoint_or_obligation_incomplete", "resume the archive room", "archive room is resumed", "room request is active again")],
  "lc4-dev-op-26": [P("required_evidence_missing", "room blockers", "room still needs", "room is waiting"), P("required_evidence_missing", "transcript blockers", "transcript still needs", "transcript is waiting")],
  "lc4-dev-op-32": [P("checkpoint_or_obligation_incomplete", "transcript is paused", "transcript goal is paused", "suspend the transcript")],
  "lc4-dev-op-36": [P("ambiguity_unreconciled", "still ambiguous", "outcome is ambiguous", "not yet confirmed", "need to reconcile", "authoritative check")],
  "lc4-dev-op-39": [P("checkpoint_or_obligation_incomplete", "resume the transcript", "transcript goal is resumed", "transcript request is active again"), P("latest_revision_unacknowledged", "tagged screen reader PDF", "screen reader PDF")],
  "lc4-dev-op-41": [P("latest_revision_unacknowledged", "MPL-1402"), P("latest_revision_unacknowledged", "August twentieth", "August 20", "2026 08 20"), P("latest_revision_unacknowledged", "tagged screen reader PDF", "screen reader PDF")],
  "lc4-dev-op-45": [P("ambiguity_unreconciled", "reconciled", "authoritative readback", "authoritative status"), P("checkpoint_or_obligation_incomplete", "still pending", "remaining blocker", "still waiting"), P("latest_revision_unacknowledged", "tagged screen reader PDF", "screen reader PDF")],
  "lc4-dev-op-48": [P("required_evidence_missing", "rights are authoritative", "rights are pending", "rights review", "rights status")],
  "lc4-dev-op-49": [P("latest_revision_unacknowledged", "Eli Park")],
  "lc4-dev-op-53": [P("required_worker_unresolved", "eligibility accepted", "eligibility result accepted"), P("required_worker_unresolved", "accessibility accepted", "accessibility result accepted"), P("required_worker_unresolved", "stale rights", "rights result rejected"), P("required_worker_unresolved", "duplicate room", "room result rejected", "room result cancelled", "room result canceled")],
  "lc4-dev-op-54": [P("ambiguity_unreconciled", "reconciled once", "one reconciliation", "reconciled exactly once"), P("terminal_claim_unsupported", "authoritative status", "confirmed by receipt", "authoritative result")],
  "lc4-dev-op-55": [P("checkpoint_or_obligation_incomplete", "archive room", "room access"), P("checkpoint_or_obligation_incomplete", "accessible transcript", "transcript request"), P("checkpoint_or_obligation_incomplete", "remaining obligation", "still pending", "remaining blocker")],
  "lc4-dev-op-58": [P("terminal_claim_unsupported", "authoritative evidence", "authoritative receipt", "not enough evidence", "cannot confirm")],
  "lc4-dev-op-60": [P("terminal_claim_unsupported", "archive room", "room access"), P("terminal_claim_unsupported", "accessible transcript", "transcript request"), P("terminal_claim_unsupported", "authoritative receipt", "authoritative evidence", "remaining blocker", "cannot confirm")],
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
    corpus_sha256: corpus.artifact_sha256,
    opportunities: corpus.opportunities.map((opportunity) => ({
      opportunity_id: opportunity.id,
      index: opportunity.index,
      stage_id: opportunity.stage_id,
      caller_text_sha256: opportunity.canonical_caller_text_sha256,
      expected_oracle: opportunity.expected_oracle,
    })),
  })}`);
}

function criteriaFor(corpus: Lc4PublicDevelopmentCorpus, opportunity: Lc4PublicDevOpportunity): readonly Lc4ListenerSemanticCriterion[] {
  const criteria: Lc4ListenerSemanticCriterion[] = [];
  const groups: PhraseGroup[] = [...(CONCEPTS[opportunity.id] ?? [])];
  for (const [key, version] of FACT_REFERENCES[opportunity.id] ?? []) {
    groups.push(P(blockerForFact(opportunity, key), ...factPhrases(factValue(corpus, key, version))));
  }
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
    opportunities: corpus.opportunities.map((opportunity) => Object.freeze({
      opportunity_id: opportunity.id,
      criteria: criteriaFor(corpus, opportunity),
    })),
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

export function lc4DevelopmentListenerCriterionBindings(
  bundle: Lc4DevelopmentListenerSemanticBundle = LC4_DEV_LISTENER_SEMANTIC_BUNDLE,
): readonly Readonly<{ opportunity_id: string; criterion_plan_sha256: string }>[] {
  return Object.freeze(bundle.plan.opportunities.map((opportunity) => Object.freeze({
    opportunity_id: opportunity.opportunity_id,
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
  corpus_sha256: string;
  semantic_plan_sha256: string;
  semantic_registry_sha256: string;
  semantic_registry_manifest_sha256: string;
  opportunity_id: string;
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
  final_required_criteria_pass: boolean;
  artifact_sha256: string;
}>;

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
  const planned = bundle.plan.opportunities.find((opportunity) => opportunity.opportunity_id === input.opportunity_id);
  if (!planned || planned.criterion_plan_sha256 !== input.criterion_plan_sha256) {
    throw new Error("LC4-DEV semantic replay opportunity or criterion plan differs from the frozen registry");
  }
  const observation = verifiedObservation({
    observation: input.observation,
    sourcePcmSha256: input.source_pcm_sha256,
    sourcePcmByteLength: input.source_pcm_byte_length,
  });
  const semanticReplay = replayLc4ListenerSemantics({
    plan: bundle.plan,
    opportunityId: input.opportunity_id,
    observation,
  });
  if (semanticReplay.criteria.length !== planned.criteria.length
    || semanticReplay.criteria.some((criterion) => criterion.pass === null)
    || semanticReplay.final_required_criteria_pass === null) {
    throw new Error("LC4-DEV semantic replay produced missing or ambiguous criterion evidence");
  }
  const body = Object.freeze({
    schema_version: 1 as const,
    semantic_version: LC4_DEV_LISTENER_SEMANTIC_VERSION,
    corpus_sha256: bundle.corpus_sha256,
    semantic_plan_sha256: bundle.plan.plan_sha256,
    semantic_registry_sha256: bundle.registry.registry_sha256,
    semantic_registry_manifest_sha256: bundle.manifest.manifest_sha256,
    opportunity_id: input.opportunity_id,
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
    final_required_criteria_pass: semanticReplay.final_required_criteria_pass,
  });
  return immutableJson({ ...body, artifact_sha256: sha256Hex(`${DEV_REPLAY_DOMAIN}${canonicalJson(body)}`) }) as unknown as Lc4DevelopmentListenerReplayArtifact;
}

/** Recomputes a retained result from its frozen plan and condition-blind ASR observation. */
export function verifyLc4DevelopmentListenerReplayArtifact(input: Readonly<{
  artifact: Lc4DevelopmentListenerReplayArtifact;
  bundle?: Lc4DevelopmentListenerSemanticBundle;
}>): Readonly<{ valid: boolean; errors: readonly string[] }> {
  const bundle = input.bundle ?? LC4_DEV_LISTENER_SEMANTIC_BUNDLE;
  const artifact = input.artifact;
  const errors: string[] = [];
  try {
    if (artifact.schema_version !== 1 || artifact.semantic_version !== LC4_DEV_LISTENER_SEMANTIC_VERSION) {
      errors.push("LC4-DEV replay schema or semantic version mismatch");
    }
    if (artifact.corpus_sha256 !== bundle.corpus_sha256
      || artifact.semantic_plan_sha256 !== bundle.plan.plan_sha256
      || artifact.semantic_registry_sha256 !== bundle.registry.registry_sha256
      || artifact.semantic_registry_manifest_sha256 !== bundle.manifest.manifest_sha256) {
      errors.push("LC4-DEV replay source-freeze binding mismatch");
    }
    const planned = bundle.plan.opportunities.find((opportunity) => opportunity.opportunity_id === artifact.opportunity_id);
    if (!planned || planned.criterion_plan_sha256 !== artifact.criterion_plan_sha256) {
      errors.push("LC4-DEV replay criterion-plan binding mismatch");
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
      opportunityId: artifact.opportunity_id,
      observation,
    });
    if (canonicalJson(replayed) !== canonicalJson(artifact.semantic_replay)
      || artifact.final_required_criteria_pass !== replayed.final_required_criteria_pass) {
      errors.push("LC4-DEV retained semantic result does not replay from the frozen criteria");
    }
    for (const digest of [
      artifact.evaluator_contract_sha256,
      artifact.evaluator_build_sha256,
      artifact.calibration_sha256,
      artifact.signed_invocation_receipt_sha256,
    ]) requireSha256(digest, "LC4-DEV replay evaluator evidence");
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
      const planned = bundle.plan.opportunities.find((opportunity) => opportunity.opportunity_id === evaluationInput.opportunity_id);
      if (!planned || planned.criterion_plan_sha256 !== evaluationInput.criterion_plan_sha256) {
        throw new Error("LC4-DEV evaluator opportunity differs from the frozen semantic plan");
      }
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
        turn: bundle.plan.opportunities.findIndex((opportunity) => opportunity.opportunity_id === evaluationInput.opportunity_id) + 1,
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
        signed_invocation_receipt_sha256: invocation.receipt.receipt_sha256,
      });
    },
  });
}

const DEVELOPMENT_BUNDLE = createLc4DevelopmentListenerSemanticBundle();

// These literal roots are the public DEV freeze boundary. If the corpus,
// phrase registry, operators, or ordering changes, this module refuses to load
// until the versioned roots are intentionally reviewed and updated.
export const LC4_DEV_LISTENER_SCHEDULE_SHA256 = "5fd258b888c801e0659a2ee418e0c66a06228ae91ae92d8336d9eb7ab3944415";
export const LC4_DEV_LISTENER_REGISTRY_SHA256 = "d1fc7ddf4a95d1affb0137cc64d26c30d9375d3538d59cc02e990204c80186d1";
export const LC4_DEV_LISTENER_REGISTRY_MANIFEST_SHA256 = "0198f4078979628c29de988605ff3c49d96ba75942b9d7de23514283bc2bf858";
export const LC4_DEV_LISTENER_PLAN_SHA256 = "0af53acf42405ee5c537ade7075fbceff22208eb3439a52e51942dda78d2d3ad";

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
