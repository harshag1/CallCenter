import { canonicalJson, sha256Hex } from "./artifacts";
import {
  LC4_DEV_LISTENER_SEMANTIC_BUNDLE,
  type Lc4DevelopmentListenerSemanticBundle,
} from "./lc4-development-listener-semantics";
import {
  LC4_LISTENER_SEMANTIC_SCORER_BUILD_SHA256,
  LC4_LISTENER_SEMANTIC_SCORER_VERSION,
  scoreLc4ListenerSemanticCriterion,
  type Lc4ListenerSemanticCriterion,
} from "./lc4-listener-evidence";

const CALIBRATION_FIXTURE_DOMAIN = "hacc/lc4/listener-semantic-calibration-fixtures/v1\n";
const CALIBRATION_ARTIFACT_DOMAIN = "hacc/lc4/listener-semantic-calibration-artifact/v1\n";

export const LC4_SEMANTIC_CALIBRATION_VERSION =
  "lc4-semantic-calibration-v1-provider-free-hard-negatives" as const;
export const LC4_SEMANTIC_CALIBRATION_FIXTURE_CORPUS_SHA256 =
  "281ca9054dfb2ea34e9be77472ad03faa41cdde135ed8b2211722c6bf91af112" as const;
export const LC4_SEMANTIC_CALIBRATION_ARTIFACT_SHA256 =
  "f7845b4ed2d95bacd69dc8ff08061fdee92f3578d477c810353028700cee6c80" as const;

export type Lc4SemanticCalibrationCategory =
  | "affirmed_phrase"
  | "affirmed_later_correction"
  | "explicit_negation"
  | "contraction_negation"
  | "stale_prefix"
  | "rejected_suffix"
  | "question"
  | "uncertainty"
  | "later_retraction"
  | "stale_current_swap"
  | "entity_swap"
  | "purpose_swap"
  | "number_swap"
  | "date_swap"
  | "prohibited_spoken_action"
  | "prohibited_spoken_promise"
  | "repair_language"
  | "exclusion_scope"
  | "hypothetical_or_reported"
  | "no_longer_or_qualified"
  | "postpositive_negation"
  | "metalinguistic_mention"
  | "negator_scope";

type CalibrationScope = "frozen_registered_criterion" | "synthetic_operator_probe";

type CalibrationCase = Readonly<{
  case_id: string;
  scope: CalibrationScope;
  opportunity_id: string | null;
  criterion_key: string;
  criterion: Lc4ListenerSemanticCriterion;
  category: Lc4SemanticCalibrationCategory;
  expected_pass: boolean;
  transcript: string;
}>;

export type Lc4SemanticCalibrationConfusion = Readonly<{
  expected_positive: number;
  expected_negative: number;
  true_positive: number;
  true_negative: number;
  false_positive: number;
  false_negative: number;
  sensitivity_ppm: number;
  specificity_ppm: number;
  accuracy_ppm: number;
}>;

export type Lc4SemanticCalibrationArtifact = Readonly<{
  schema_version: 1;
  calibration_version: typeof LC4_SEMANTIC_CALIBRATION_VERSION;
  scorer_version: typeof LC4_LISTENER_SEMANTIC_SCORER_VERSION;
  scorer_build_sha256: string;
  semantic_plan_sha256: string;
  semantic_registry_sha256: string;
  fixture_corpus_sha256: string;
  provider_calls_made: 0;
  claim_boundary: "deterministic_authored_regression_calibration_not_asr_or_provider_efficacy";
  coverage: Readonly<{
    canonical_opportunities: number;
    semantic_subjects: number;
    applicable_semantic_subjects: number;
    not_applicable_semantic_subjects: number;
    frozen_registered_criteria: number;
    synthetic_operator_criteria: number;
    fixture_cases: number;
    op42: Readonly<{
      present: boolean;
      applicability: "applicable" | "not_applicable" | "absent";
      semantic_subject_count: number;
      criterion_count: number;
    }>;
  }>;
  aggregate: Lc4SemanticCalibrationConfusion;
  by_category: readonly Readonly<{
    category: Lc4SemanticCalibrationCategory;
    confusion: Lc4SemanticCalibrationConfusion;
  }>[];
  by_criterion: readonly Readonly<{
    scope: CalibrationScope;
    opportunity_id: string | null;
    criterion_key: string;
    operator: Lc4ListenerSemanticCriterion["operator"];
    phrase_count: number;
    confusion: Lc4SemanticCalibrationConfusion;
  }>[];
  cases: readonly Readonly<{
    case_id: string;
    scope: CalibrationScope;
    opportunity_id: string | null;
    criterion_key: string;
    category: Lc4SemanticCalibrationCategory;
    transcript_sha256: string;
    expected_pass: boolean;
    observed_pass: boolean;
    correct: boolean;
  }>[];
  failed_case_ids: readonly string[];
  artifact_sha256: string;
}>;

const criterion = (
  criterionId: string,
  operator: Lc4ListenerSemanticCriterion["operator"],
  ...phrases: readonly string[]
): Lc4ListenerSemanticCriterion => Object.freeze({
  criterion_id: criterionId,
  operator,
  phrases: Object.freeze(phrases),
  required_for_final_scorer: true,
  crp_blocker: null,
});

function registeredCases(bundle: Lc4DevelopmentListenerSemanticBundle): readonly CalibrationCase[] {
  const cases: CalibrationCase[] = [];
  for (const opportunity of bundle.plan.opportunities) {
    for (const plannedCriterion of opportunity.criteria) {
      const criterionKey = `${opportunity.opportunity_id}/${plannedCriterion.criterion_id}`;
      const firstPhrase = plannedCriterion.phrases[0]!;
      const singlePhraseAffirmationPasses = plannedCriterion.operator === "contains_any"
        || (plannedCriterion.operator !== "contains_none" && plannedCriterion.phrases.length === 1);
      const suppressedPhrasePasses = plannedCriterion.operator === "contains_none";
      plannedCriterion.phrases.forEach((phrase, phraseIndex) => {
        cases.push(Object.freeze({
          case_id: `${criterionKey}/affirmed-${phraseIndex + 1}`,
          scope: "frozen_registered_criterion",
          opportunity_id: opportunity.opportunity_id,
          criterion_key: criterionKey,
          criterion: plannedCriterion,
          category: "affirmed_phrase",
          expected_pass: singlePhraseAffirmationPasses,
          transcript: `Confirmed: ${phrase}.`,
        }));
      });
      if ((plannedCriterion.operator === "contains_all" || plannedCriterion.operator === "contains_ordered")
        && plannedCriterion.phrases.length > 1) {
        cases.push(Object.freeze({
          case_id: `${criterionKey}/affirmed-composite`,
          scope: "frozen_registered_criterion",
          opportunity_id: opportunity.opportunity_id,
          criterion_key: criterionKey,
          criterion: plannedCriterion,
          category: "affirmed_phrase",
          expected_pass: true,
          transcript: plannedCriterion.phrases.map((phrase) => `Confirmed: ${phrase}.`).join(" "),
        }));
      }
      const fixtures: readonly Readonly<{
        suffix: string;
        category: Lc4SemanticCalibrationCategory;
        expected: boolean;
        transcript: string;
      }>[] = Object.freeze([
        {
          suffix: "corrected-current",
          category: "affirmed_later_correction",
          expected: singlePhraseAffirmationPasses,
          transcript: `The earlier value was a different value. Correction: use ${firstPhrase}.`,
        },
        {
          suffix: "explicit-negation",
          category: "explicit_negation",
          expected: suppressedPhrasePasses,
          transcript: `That is not ${firstPhrase}.`,
        },
        {
          suffix: "contraction-negation",
          category: "contraction_negation",
          expected: suppressedPhrasePasses,
          transcript: `That isn't ${firstPhrase}.`,
        },
        {
          suffix: "stale-prefix",
          category: "stale_prefix",
          expected: suppressedPhrasePasses,
          transcript: `The old ${firstPhrase} is obsolete.`,
        },
        {
          suffix: "rejected-suffix",
          category: "rejected_suffix",
          expected: suppressedPhrasePasses,
          transcript: `${firstPhrase} is incorrect.`,
        },
        {
          suffix: "question",
          category: "question",
          expected: suppressedPhrasePasses,
          transcript: `Is ${firstPhrase}?`,
        },
        {
          suffix: "uncertainty",
          category: "uncertainty",
          expected: suppressedPhrasePasses,
          transcript: `Maybe ${firstPhrase}.`,
        },
        {
          suffix: "later-retraction",
          category: "later_retraction",
          expected: suppressedPhrasePasses,
          transcript: `${firstPhrase}. Correction: that was wrong; use a different value instead.`,
        },
      ]);
      for (const fixture of fixtures) {
        cases.push(Object.freeze({
          case_id: `${criterionKey}/${fixture.suffix}`,
          scope: "frozen_registered_criterion",
          opportunity_id: opportunity.opportunity_id,
          criterion_key: criterionKey,
          criterion: plannedCriterion,
          category: fixture.category,
          expected_pass: fixture.expected,
          transcript: fixture.transcript,
        }));
      }
    }
  }
  return Object.freeze(cases);
}

function syntheticCases(): readonly CalibrationCase[] {
  const currentRecord = criterion("current-record", "contains_any", "MPL-1402");
  const currentDate = criterion("current-date", "contains_any", "August twentieth", "August 20", "2026 08 20");
  const currentGuest = criterion("current-guest", "contains_any", "Eli Park");
  const currentPurpose = criterion("current-purpose", "contains_any", "family history research");
  const prohibitedAction = criterion(
    "no-prohibited-action",
    "contains_none",
    "reserve archive room",
    "send the transcript",
  );
  const rows: readonly Readonly<{
    id: string;
    criterion: Lc4ListenerSemanticCriterion;
    category: Lc4SemanticCalibrationCategory;
    expected: boolean;
    transcript: string;
  }>[] = Object.freeze([
    {
      id: "number/current",
      criterion: currentRecord,
      category: "number_swap",
      expected: true,
      transcript: "The current record is MPL-1402.",
    },
    {
      id: "number/stale",
      criterion: currentRecord,
      category: "number_swap",
      expected: false,
      transcript: "The current record is MPL-1042.",
    },
    {
      id: "number/stale-to-current",
      criterion: currentRecord,
      category: "stale_current_swap",
      expected: true,
      transcript: "I first had MPL-1042. Correction: the current record is MPL-1402.",
    },
    {
      id: "number/current-to-stale",
      criterion: currentRecord,
      category: "stale_current_swap",
      expected: false,
      transcript: "I first had MPL-1402. Correction: the current record is MPL-1042.",
    },
    {
      id: "date/current",
      criterion: currentDate,
      category: "date_swap",
      expected: true,
      transcript: "The current visit is August twentieth.",
    },
    {
      id: "date/stale",
      criterion: currentDate,
      category: "date_swap",
      expected: false,
      transcript: "The current visit is August eighteenth.",
    },
    {
      id: "date/retracted",
      criterion: currentDate,
      category: "date_swap",
      expected: false,
      transcript: "The visit is August twentieth. Correction: use August eighteenth.",
    },
    {
      id: "entity/current",
      criterion: currentGuest,
      category: "entity_swap",
      expected: true,
      transcript: "The current guest is Eli Park.",
    },
    {
      id: "entity/stale",
      criterion: currentGuest,
      category: "entity_swap",
      expected: false,
      transcript: "The current guest is Mina Park.",
    },
    {
      id: "entity/retracted",
      criterion: currentGuest,
      category: "entity_swap",
      expected: false,
      transcript: "The guest is Eli Park. Sorry, correction: the guest is Mina Park.",
    },
    {
      id: "purpose/current",
      criterion: currentPurpose,
      category: "purpose_swap",
      expected: true,
      transcript: "The purpose is family history research.",
    },
    {
      id: "purpose/swap",
      criterion: currentPurpose,
      category: "purpose_swap",
      expected: false,
      transcript: "The purpose is commercial publication.",
    },
    {
      id: "repair/affirmed",
      criterion: currentRecord,
      category: "repair_language",
      expected: true,
      transcript: "I acknowledge the repair: MPL-1402 is the current record.",
    },
    {
      id: "repair/question-echo",
      criterion: currentRecord,
      category: "repair_language",
      expected: false,
      transcript: "Please tell me whether MPL-1402 is the current record?",
    },
    {
      id: "repair/stale-to-current",
      criterion: currentRecord,
      category: "repair_language",
      expected: true,
      transcript: "MPL-1042 was the prior record. Sorry, correction: use MPL-1402.",
    },
    {
      id: "repair/current-to-stale",
      criterion: currentRecord,
      category: "repair_language",
      expected: false,
      transcript: "MPL-1402 was the record. Sorry, correction: use MPL-1042.",
    },
    {
      id: "exclusion/anything-but",
      criterion: currentRecord,
      category: "exclusion_scope",
      expected: false,
      transcript: "The current record is anything but MPL-1402.",
    },
    {
      id: "exclusion/other-than",
      criterion: currentRecord,
      category: "exclusion_scope",
      expected: false,
      transcript: "Use a record other than MPL-1402.",
    },
    {
      id: "exclusion/far-from",
      criterion: currentRecord,
      category: "exclusion_scope",
      expected: false,
      transcript: "The actual record is far from MPL-1402.",
    },
    {
      id: "hypothetical/suppose",
      criterion: currentRecord,
      category: "hypothetical_or_reported",
      expected: false,
      transcript: "Suppose the current record is MPL-1402.",
    },
    {
      id: "hypothetical/unless",
      criterion: currentRecord,
      category: "hypothetical_or_reported",
      expected: false,
      transcript: "Unless corrected, MPL-1402 is the record.",
    },
    {
      id: "reported/question",
      criterion: currentRecord,
      category: "hypothetical_or_reported",
      expected: false,
      transcript: "The caller asked is MPL-1402 the current record.",
    },
    {
      id: "qualified/no-longer",
      criterion: currentRecord,
      category: "no_longer_or_qualified",
      expected: false,
      transcript: "MPL-1402 is no longer current.",
    },
    {
      id: "qualified/supposedly",
      criterion: currentRecord,
      category: "no_longer_or_qualified",
      expected: false,
      transcript: "MPL-1402, supposedly.",
    },
    {
      id: "postpositive/not-current",
      criterion: currentRecord,
      category: "postpositive_negation",
      expected: false,
      transcript: "MPL-1402 is not the current record.",
    },
    {
      id: "postpositive/not-verified",
      criterion: currentRecord,
      category: "postpositive_negation",
      expected: false,
      transcript: "MPL-1402 has not been verified.",
    },
    {
      id: "qualified/may-be",
      criterion: currentRecord,
      category: "no_longer_or_qualified",
      expected: false,
      transcript: "MPL-1402 may be the current record.",
    },
    {
      id: "hypothetical/either-or",
      criterion: currentRecord,
      category: "hypothetical_or_reported",
      expected: false,
      transcript: "Either MPL-1402 or MPL-1042 is current.",
    },
    {
      id: "metalinguistic/string",
      criterion: currentRecord,
      category: "metalinguistic_mention",
      expected: false,
      transcript: "The transcript contains the string MPL-1402.",
    },
    {
      id: "hypothetical/counterfactual",
      criterion: currentRecord,
      category: "hypothetical_or_reported",
      expected: false,
      transcript: "Had the record been MPL-1402, we would proceed.",
    },
    {
      id: "retraction/take-back",
      criterion: currentRecord,
      category: "later_retraction",
      expected: false,
      transcript: "MPL-1402 is current. I take that back.",
    },
    {
      id: "retraction/explicit",
      criterion: currentRecord,
      category: "later_retraction",
      expected: false,
      transcript: "MPL-1402 is current. I retract that statement.",
    },
    {
      id: "prohibited/affirmed-action",
      criterion: prohibitedAction,
      category: "prohibited_spoken_action",
      expected: false,
      transcript: "I will reserve archive room now.",
    },
    {
      id: "prohibited/unrelated-negation",
      criterion: prohibitedAction,
      category: "negator_scope",
      expected: false,
      transcript: "I will not delay and will reserve archive room now.",
    },
    {
      id: "prohibited/no-reason-scope",
      criterion: prohibitedAction,
      category: "negator_scope",
      expected: false,
      transcript: "There is no reason to wait and I will reserve archive room now.",
    },
    {
      id: "prohibited/affirmed-promise",
      criterion: prohibitedAction,
      category: "prohibited_spoken_promise",
      expected: false,
      transcript: "I promise to reserve archive room.",
    },
    {
      id: "prohibited/negated-action",
      criterion: prohibitedAction,
      category: "prohibited_spoken_action",
      expected: true,
      transcript: "I will not reserve archive room while evidence is missing.",
    },
    {
      id: "prohibited/contraction",
      criterion: prohibitedAction,
      category: "prohibited_spoken_action",
      expected: true,
      transcript: "I won't reserve archive room while evidence is missing.",
    },
    {
      id: "prohibited/question",
      criterion: prohibitedAction,
      category: "prohibited_spoken_action",
      expected: true,
      transcript: "Should I reserve archive room?",
    },
    {
      id: "prohibited/uncertain",
      criterion: prohibitedAction,
      category: "prohibited_spoken_action",
      expected: true,
      transcript: "Maybe I could reserve archive room.",
    },
    {
      id: "prohibited/withdrawn",
      criterion: prohibitedAction,
      category: "prohibited_spoken_action",
      expected: true,
      transcript: "I will reserve archive room. Correction: I will not reserve archive room.",
    },
    {
      id: "prohibited-later-affirmed",
      criterion: prohibitedAction,
      category: "prohibited_spoken_action",
      expected: false,
      transcript: "I will not reserve archive room. Correction: I will reserve archive room.",
    },
  ]);
  return Object.freeze(rows.map((row) => Object.freeze({
    case_id: `synthetic/${row.id}`,
    scope: "synthetic_operator_probe" as const,
    opportunity_id: null,
    criterion_key: `synthetic/${row.criterion.criterion_id}`,
    criterion: row.criterion,
    category: row.category,
    expected_pass: row.expected,
    transcript: row.transcript,
  })));
}

function ppm(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator * 1_000_000) / denominator);
}

function confusion(rows: readonly Readonly<{
  expected_pass: boolean;
  observed_pass: boolean;
}>[]): Lc4SemanticCalibrationConfusion {
  const expectedPositive = rows.filter((row) => row.expected_pass).length;
  const expectedNegative = rows.length - expectedPositive;
  const truePositive = rows.filter((row) => row.expected_pass && row.observed_pass).length;
  const trueNegative = rows.filter((row) => !row.expected_pass && !row.observed_pass).length;
  const falsePositive = rows.filter((row) => !row.expected_pass && row.observed_pass).length;
  const falseNegative = rows.filter((row) => row.expected_pass && !row.observed_pass).length;
  return Object.freeze({
    expected_positive: expectedPositive,
    expected_negative: expectedNegative,
    true_positive: truePositive,
    true_negative: trueNegative,
    false_positive: falsePositive,
    false_negative: falseNegative,
    sensitivity_ppm: ppm(truePositive, expectedPositive),
    specificity_ppm: ppm(trueNegative, expectedNegative),
    accuracy_ppm: ppm(truePositive + trueNegative, rows.length),
  });
}

function artifactBody(artifact: Omit<Lc4SemanticCalibrationArtifact, "artifact_sha256">) {
  return artifact;
}

/**
 * Provider-free, deterministic authored regression calibration. This measures
 * the frozen lexical/polarity scorer only; it is not an ASR, voice-provider,
 * natural-language-generalization, or HACC-effectiveness estimate.
 */
export function createLc4SemanticCalibrationArtifact(
  bundle: Lc4DevelopmentListenerSemanticBundle = LC4_DEV_LISTENER_SEMANTIC_BUNDLE,
): Lc4SemanticCalibrationArtifact {
  const fixtures = Object.freeze([...registeredCases(bundle), ...syntheticCases()]);
  const fixtureCorpusSha256 = sha256Hex(`${CALIBRATION_FIXTURE_DOMAIN}${canonicalJson(fixtures)}`);
  const scored = Object.freeze(fixtures.map((fixture) => {
    const observedPass = scoreLc4ListenerSemanticCriterion(fixture.criterion, fixture.transcript);
    return Object.freeze({
      fixture,
      observed_pass: observedPass,
      correct: observedPass === fixture.expected_pass,
    });
  }));
  const resultRows = Object.freeze(scored.map(({ fixture, observed_pass, correct }) => Object.freeze({
    case_id: fixture.case_id,
    scope: fixture.scope,
    opportunity_id: fixture.opportunity_id,
    criterion_key: fixture.criterion_key,
    category: fixture.category,
    transcript_sha256: sha256Hex(Buffer.from(fixture.transcript, "utf8")),
    expected_pass: fixture.expected_pass,
    observed_pass: observed_pass,
    correct,
  })));
  const criterionKeys = [...new Set(fixtures.map((fixture) => fixture.criterion_key))].sort();
  const categories = [...new Set(fixtures.map((fixture) => fixture.category))].sort();
  const op42Subjects = bundle.plan.opportunities.filter((opportunity) =>
    opportunity.opportunity_id === "lc4-dev-op-42"
    || opportunity.opportunity_id.startsWith("lc4-dev-op-42:"));
  const op42Applicable = op42Subjects.filter((subject) => subject.applicability.status === "applicable").length;
  const op42Applicability = op42Subjects.length === 0
    ? "absent" as const
    : op42Applicable === 0
      ? "not_applicable" as const
      : "applicable" as const;
  const frozenRegisteredCriteria = bundle.plan.opportunities
    .reduce((count, opportunity) => count + opportunity.criteria.length, 0);
  const canonicalOpportunities = new Set(bundle.plan.opportunities.map((opportunity) =>
    opportunity.opportunity_id.replace(/:[^:]+$/u, "")));
  const body = Object.freeze({
    schema_version: 1 as const,
    calibration_version: LC4_SEMANTIC_CALIBRATION_VERSION,
    scorer_version: LC4_LISTENER_SEMANTIC_SCORER_VERSION,
    scorer_build_sha256: LC4_LISTENER_SEMANTIC_SCORER_BUILD_SHA256,
    semantic_plan_sha256: bundle.plan.plan_sha256,
    semantic_registry_sha256: bundle.registry.registry_sha256,
    fixture_corpus_sha256: fixtureCorpusSha256,
    provider_calls_made: 0 as const,
    claim_boundary: "deterministic_authored_regression_calibration_not_asr_or_provider_efficacy" as const,
    coverage: Object.freeze({
      canonical_opportunities: canonicalOpportunities.size,
      semantic_subjects: bundle.plan.opportunities.length,
      applicable_semantic_subjects: bundle.plan.opportunities
        .filter((opportunity) => opportunity.applicability.status === "applicable").length,
      not_applicable_semantic_subjects: bundle.plan.opportunities
        .filter((opportunity) => opportunity.applicability.status === "not_applicable").length,
      frozen_registered_criteria: frozenRegisteredCriteria,
      synthetic_operator_criteria: new Set(syntheticCases().map((fixture) => fixture.criterion_key)).size,
      fixture_cases: fixtures.length,
      op42: Object.freeze({
        present: op42Subjects.length > 0,
        applicability: op42Applicability,
        semantic_subject_count: op42Subjects.length,
        criterion_count: op42Subjects.reduce((count, subject) => count + subject.criteria.length, 0),
      }),
    }),
    aggregate: confusion(resultRows),
    by_category: Object.freeze(categories.map((category) => Object.freeze({
      category,
      confusion: confusion(resultRows.filter((row) => row.category === category)),
    }))),
    by_criterion: Object.freeze(criterionKeys.map((criterionKey) => {
      const criterionFixtures = fixtures.filter((fixture) => fixture.criterion_key === criterionKey);
      const sample = criterionFixtures[0]!;
      return Object.freeze({
        scope: sample.scope,
        opportunity_id: sample.opportunity_id,
        criterion_key: criterionKey,
        operator: sample.criterion.operator,
        phrase_count: sample.criterion.phrases.length,
        confusion: confusion(resultRows.filter((row) => row.criterion_key === criterionKey)),
      });
    })),
    cases: resultRows,
    failed_case_ids: Object.freeze(resultRows.filter((row) => !row.correct).map((row) => row.case_id)),
  });
  return Object.freeze({
    ...body,
    artifact_sha256: sha256Hex(`${CALIBRATION_ARTIFACT_DOMAIN}${canonicalJson(artifactBody(body))}`),
  });
}

/** Fail-closed source gate consumed by launch publication. */
export function assertLc4SemanticCalibrationAuthority(
  artifact: Lc4SemanticCalibrationArtifact = createLc4SemanticCalibrationArtifact(),
): void {
  if (artifact.fixture_corpus_sha256 !== LC4_SEMANTIC_CALIBRATION_FIXTURE_CORPUS_SHA256
    || artifact.artifact_sha256 !== LC4_SEMANTIC_CALIBRATION_ARTIFACT_SHA256
    || artifact.scorer_version !== LC4_LISTENER_SEMANTIC_SCORER_VERSION
    || artifact.scorer_build_sha256 !== LC4_LISTENER_SEMANTIC_SCORER_BUILD_SHA256
    || artifact.semantic_plan_sha256 !== LC4_DEV_LISTENER_SEMANTIC_BUNDLE.plan.plan_sha256
    || artifact.aggregate.false_positive !== 0
    || artifact.aggregate.false_negative !== 0
    || artifact.aggregate.sensitivity_ppm !== 1_000_000
    || artifact.aggregate.specificity_ppm !== 1_000_000
    || artifact.failed_case_ids.length !== 0) {
    throw new Error("LC4 semantic calibration authority differs from the reviewed all-pass artifact");
  }
}
