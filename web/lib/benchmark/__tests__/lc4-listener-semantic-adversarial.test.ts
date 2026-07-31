import { describe, expect, it } from "vitest";

import adversarialCorpusJson
  from "./fixtures/lc4-listener-semantic-adversarial-v1.json";
import { canonicalJson, sha256Hex } from "../artifacts";
import {
  scoreLc4ListenerSemanticCriterion,
  type Lc4ListenerSemanticCriterion,
} from "../lc4-listener-evidence";

const CORPUS_DOMAIN = "hacc/lc4/listener-semantic-adversarial-corpus/v1\n";
const EXPECTED_CORPUS_SHA256 = "191ea940a13515083030d43e62b72af80f485db8e03fa7e8d316df275ecd8b8c";

type AdversarialCase = Readonly<{
  case_id: string;
  construct: string;
  pair_id?: string;
  operator: "contains_any" | "contains_none";
  phrases: readonly string[];
  transcript: string;
  expected_pass: boolean;
  rationale: string;
}>;

type AdversarialCorpus = Readonly<{
  schema_version: 1;
  corpus_id: "lc4-listener-semantic-adversarial-v1";
  claim_boundary:
    "independently_authored_targeted_construct_challenge_not_population_accuracy_or_provider_efficacy";
  provider_calls_made: 0;
  cases: readonly AdversarialCase[];
}>;

const corpus = adversarialCorpusJson as AdversarialCorpus;

function criterionFor(testCase: AdversarialCase): Lc4ListenerSemanticCriterion {
  return Object.freeze({
    criterion_id: testCase.case_id,
    operator: testCase.operator,
    phrases: Object.freeze([...testCase.phrases]),
    required_for_final_scorer: true,
    crp_blocker: null,
  });
}

describe("LC4 independently authored semantic construct challenge", () => {
  it("keeps the provider-free release corpus sealed, balanced, and non-vacuous", () => {
    expect(corpus.schema_version).toBe(1);
    expect(corpus.corpus_id).toBe("lc4-listener-semantic-adversarial-v1");
    expect(corpus.provider_calls_made).toBe(0);
    expect(corpus.claim_boundary)
      .toBe("independently_authored_targeted_construct_challenge_not_population_accuracy_or_provider_efficacy");
    expect(corpus.cases).toHaveLength(74);
    expect(new Set(corpus.cases.map((testCase) => testCase.case_id)).size).toBe(74);
    expect(new Set(corpus.cases.map((testCase) => testCase.construct)).size).toBeGreaterThanOrEqual(12);
    expect(corpus.cases.some((testCase) => testCase.expected_pass)).toBe(true);
    expect(corpus.cases.some((testCase) => !testCase.expected_pass)).toBe(true);
    expect(corpus.cases.some((testCase) => testCase.operator === "contains_any")).toBe(true);
    expect(corpus.cases.some((testCase) => testCase.operator === "contains_none")).toBe(true);
    for (const testCase of corpus.cases) {
      expect(testCase.case_id).toMatch(/^[a-z0-9][a-z0-9/-]+$/u);
      expect(testCase.phrases.length, testCase.case_id).toBeGreaterThan(0);
      expect(testCase.transcript.trim(), testCase.case_id).toBe(testCase.transcript);
      expect(testCase.transcript.length, testCase.case_id).toBeGreaterThan(0);
      expect(testCase.rationale.length, testCase.case_id).toBeGreaterThan(20);
    }
    expect(sha256Hex(`${CORPUS_DOMAIN}${canonicalJson(corpus)}`))
      .toBe(EXPECTED_CORPUS_SHA256);
  });

  it("fails closed on every independently authored semantic construct", () => {
    const results = corpus.cases.map((testCase) => {
      const observedPass = scoreLc4ListenerSemanticCriterion(
        criterionFor(testCase),
        testCase.transcript,
      );
      return Object.freeze({
        case_id: testCase.case_id,
        construct: testCase.construct,
        expected_pass: testCase.expected_pass,
        observed_pass: observedPass,
        correct: observedPass === testCase.expected_pass,
        rationale: testCase.rationale,
        transcript: testCase.transcript,
      });
    });
    const failures = results.filter((result) => !result.correct);
    expect(
      failures,
      `${failures.length}/${results.length} targeted construct challenges failed:\n${JSON.stringify(failures, null, 2)}`,
    ).toEqual([]);
  });

  it("is invariant across registered ASR-punctuation twins", () => {
    const pairs = new Map<string, AdversarialCase[]>();
    for (const testCase of corpus.cases) {
      if (!testCase.pair_id) continue;
      const current = pairs.get(testCase.pair_id) ?? [];
      current.push(testCase);
      pairs.set(testCase.pair_id, current);
    }
    expect(pairs.size).toBeGreaterThanOrEqual(3);
    for (const [pairId, pairCases] of pairs) {
      expect(pairCases.length, pairId).toBeGreaterThanOrEqual(2);
      expect(new Set(pairCases.map((testCase) => testCase.expected_pass)).size, pairId).toBe(1);
      const observed = pairCases.map((testCase) =>
        scoreLc4ListenerSemanticCriterion(criterionFor(testCase), testCase.transcript));
      expect(new Set(observed).size, pairId).toBe(1);
      expect(observed.every((pass) => pass === pairCases[0]!.expected_pass), pairId).toBe(true);
    }
  });
});
